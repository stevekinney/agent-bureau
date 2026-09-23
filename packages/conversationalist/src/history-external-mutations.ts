import { ensureConversationSafe } from './conversation/validation';
import type { ConversationEventDetail } from './events';
import type { ConversationChangeContext } from './history-events';
import type { ConversationStoreSnapshot } from './history-transaction';
import type { ConversationHistory } from './types';
type ConversationMutationOptions = {
  readonly expectedRevision: number;
  readonly correlationId?: string;
  readonly actor?: string;
  readonly durability?: ConversationEventDetail['durability'];
};
type ConversationMutationResult =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false;
      readonly revision: number;
      readonly reason: 'revision-conflict' | 'stale-external-event' | 'invalid-external-snapshot';
    };

type ExternalHooks = {
  readonly current: () => ConversationHistory;
  readonly revision: () => number;
  readonly assertOpen: () => void;
  readonly detail: (
    action: 'mutation.rejected',
    previous: ConversationHistory,
    context: ConversationChangeContext,
  ) => ConversationEventDetail;
  readonly emit: (type: 'mutation.rejected', detail: ConversationEventDetail) => void;
  readonly commit: (next: ConversationHistory, context: ConversationChangeContext) => void;
};

export function createExternalMutationActions(hooks: ExternalHooks) {
  const rejected = (
    options: ConversationMutationOptions,
    reason: 'revision-conflict' | 'stale-external-event' | 'invalid-external-snapshot',
    outcome: 'rejected' | 'discarded' = 'rejected',
  ): ConversationMutationResult => {
    hooks.emit(
      'mutation.rejected',
      hooks.detail('mutation.rejected', hooks.current(), {
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.actor ? { actor: options.actor } : {}),
        durability: options.durability ?? 'external',
        outcome,
        reason,
      }),
    );
    return Object.freeze({ accepted: false, revision: hooks.revision(), reason });
  };
  const applyMutation = (
    options: ConversationMutationOptions,
    mutation: (conversation: ConversationHistory) => ConversationHistory,
  ): ConversationMutationResult => {
    hooks.assertOpen();
    if (options.expectedRevision !== hooks.revision())
      return rejected(options, 'revision-conflict');
    const startingRevision = hooks.revision();
    const next = mutation(hooks.current());
    if (hooks.revision() !== startingRevision) return rejected(options, 'revision-conflict');
    hooks.commit(next, {
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.durability ? { durability: options.durability } : {}),
    });
    return Object.freeze({ accepted: true, revision: hooks.revision() });
  };
  const reconcileExternalSnapshot = (
    snapshot: ConversationStoreSnapshot,
    options: Omit<ConversationMutationOptions, 'expectedRevision'> = {},
  ): ConversationMutationResult => {
    hooks.assertOpen();
    if (
      snapshot.conversation.id !== hooks.current().id ||
      snapshot.lifecycle !== 'open' ||
      snapshot.revision < 0 ||
      !Number.isSafeInteger(snapshot.revision)
    )
      return rejected(
        { expectedRevision: hooks.revision(), ...options },
        'invalid-external-snapshot',
      );
    if (snapshot.revision !== hooks.revision() + 1)
      return rejected(
        { expectedRevision: hooks.revision(), ...options },
        'stale-external-event',
        'discarded',
      );
    try {
      const safe = ensureConversationSafe(structuredClone(snapshot.conversation));
      hooks.commit(safe, {
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.actor ? { actor: options.actor } : {}),
        durability: 'external',
      });
      return Object.freeze({ accepted: true, revision: hooks.revision() });
    } catch {
      return rejected(
        { expectedRevision: hooks.revision(), ...options },
        'invalid-external-snapshot',
      );
    }
  };
  return { applyMutation, reconcileExternalSnapshot };
}
