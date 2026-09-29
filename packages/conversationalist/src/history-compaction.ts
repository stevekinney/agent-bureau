import { compactConversation } from './compaction/compact';
import type {
  CompactionAttempt,
  CompactionOptions,
  CompactionResult,
  ConversationCompactionResult,
  Summarizer,
} from './compaction/types';
import { estimateConversationTokens } from './context';
import { defaultConversationRuntime, type ConversationEnvironment } from './environment';
import { createOperationCancelledError } from './errors';
import type { ConversationActionType, ConversationEventDetail } from './events';
import type { ConversationChangeContext } from './history-events';
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
    context: ConversationChangeContext,
  ) => ConversationEventDetail;
  /**
   * Publishes the candidate by compare-and-swap against `baseRevision`.
   * `false` means the conversation moved on and nothing was written.
   */
  readonly commitAtRevision: (
    baseRevision: number,
    conversation: ConversationHistory,
    previous: ConversationHistory,
    attempt: CompactionAttempt,
  ) => boolean;
};

/** One attempt's fixed identity, and a way to report on it at any later moment. */
type AttemptTracker = {
  readonly baseRevision: number;
  readonly report: (candidate?: ConversationHistory) => CompactionAttempt;
};

function trackAttempt(
  base: ConversationHistory,
  environment: ConversationEnvironment,
  hooks: CompactionHooks,
): AttemptTracker {
  const runtime = environment.runtime ?? defaultConversationRuntime;
  const attemptId = runtime.identifiers.next('compaction');
  const startedAt = runtime.clock.now();
  const baseRevision = hooks.revision();
  const baseTokens = estimateConversationTokens(base, undefined, environment);
  return {
    baseRevision,
    report: (candidate) => ({
      attemptId,
      baseRevision,
      observedRevision: hooks.revision(),
      // A wall clock can be set backwards mid-attempt; a duration cannot be negative.
      durationMs: Math.max(0, runtime.clock.now() - startedAt),
      baseTokens,
      ...(candidate
        ? { candidateTokens: estimateConversationTokens(candidate, undefined, environment) }
        : {}),
    }),
  };
}

/**
 * Runs one compaction attempt against the snapshot current at call time.
 *
 * The summary and the retained recent context are built as a candidate that
 * nothing else can see. The candidate becomes the model-visible history only
 * through {@link CompactionHooks.commitAtRevision}, a compare-and-swap on the
 * controller revision captured here. Any write that lands while the
 * summarizer runs moves that revision, so the candidate is discarded and the
 * newer history is left exactly as it is.
 */
export async function compactOwned(
  summarizer: Summarizer,
  options: CompactionOptions | undefined,
  environment: ConversationEnvironment,
  hooks: CompactionHooks,
): Promise<ConversationCompactionResult> {
  const previous = hooks.current();
  const attempt = trackAttempt(previous, environment, hooks);
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
    hooks.detail('compaction.started', previous, {
      outcome: 'started',
      compaction: attempt.report(),
    }),
  );
  let compacted: Awaited<typeof operation>;
  try {
    compacted = await operation;
  } catch (error) {
    throw handleCompactionError(error, operationSignal, previous, attempt, hooks);
  } finally {
    hooks.untrack(operation);
  }
  ensureCompactionActive(operationSignal, previous, attempt, hooks);
  const settled = attempt.report(compacted.conversation);
  if (compacted.result.compacted) {
    if (hooks.commitAtRevision(attempt.baseRevision, compacted.conversation, previous, settled)) {
      return {
        ...compacted.result,
        compacted: true,
        outcome: 'committed',
        revision: hooks.revision(),
        attempt: settled,
      };
    }
  } else if (settled.observedRevision === attempt.baseRevision) {
    const result: ConversationCompactionResult = {
      ...compacted.result,
      compacted: false,
      outcome: 'no-op',
      revision: settled.observedRevision,
      attempt: settled,
    };
    hooks.event(
      'compaction.completed',
      hooks.detail('compaction.completed', previous, {
        outcome: 'completed',
        compaction: settled,
      }),
    );
    return result;
  }
  return discard(compacted.result, previous, settled, hooks);
}

function discard(
  candidate: CompactionResult,
  previous: ConversationHistory,
  attempt: CompactionAttempt,
  hooks: CompactionHooks,
): ConversationCompactionResult {
  const result: ConversationCompactionResult = {
    compacted: false,
    chunksProcessed: candidate.chunksProcessed,
    messagesRemoved: 0,
    summaryContent: '',
    outcome: 'discarded',
    reason: 'revision-conflict',
    revision: attempt.observedRevision,
    attempt,
  };
  hooks.event(
    'compaction.stale-discarded',
    hooks.detail('compaction.stale-discarded', previous, {
      outcome: 'discarded',
      reason: 'revision-conflict',
      compaction: attempt,
    }),
  );
  return result;
}

function handleCompactionError(
  error: unknown,
  signal: AbortSignal,
  previous: ConversationHistory,
  attempt: AttemptTracker,
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
        compaction: attempt.report(),
      }),
    );
  }
  if (cancelled) return createOperationCancelledError(hooks.current().id, 'compaction');
  return error instanceof Error ? error : new Error(String(error));
}

function ensureCompactionActive(
  signal: AbortSignal,
  previous: ConversationHistory,
  attempt: AttemptTracker,
  hooks: CompactionHooks,
): void {
  if (!signal.aborted && hooks.lifecycle() === 'open') return;
  if (hooks.lifecycle() === 'open') {
    hooks.event(
      'compaction.cancelled',
      hooks.detail('compaction.cancelled', previous, {
        outcome: 'cancelled',
        reason: String(signal.reason),
        compaction: attempt.report(),
      }),
    );
  }
  throw createOperationCancelledError(hooks.current().id, 'compaction');
}
