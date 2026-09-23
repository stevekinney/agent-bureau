import type { ConversationEventDetail } from './events';
import type { ConversationChangeContext } from './history-events';
import type { HistoryLifecycle } from './history-lifecycle';
import type { HistoryTransaction } from './history-transaction';
import type { ConversationHistory } from './types';

type LifecycleActionsHooks = {
  readonly lifecycle: HistoryLifecycle;
  readonly transaction: HistoryTransaction;
  readonly current: () => ConversationHistory;
  readonly buildDetail: (
    action: 'controller.closed' | 'controller.disposed',
    previous: ConversationHistory,
    context: ConversationChangeContext,
  ) => ConversationEventDetail;
  readonly emit: (
    type: 'controller.closed' | 'controller.disposed',
    detail: ConversationEventDetail,
  ) => void;
};

export function createLifecycleActions(hooks: LifecycleActionsHooks) {
  const close = (): void => {
    if (!hooks.lifecycle.close(hooks.current().id)) return;
    const previous = hooks.current();
    hooks.emit(
      'controller.closed',
      hooks.buildDetail('controller.closed', previous, {
        durability: 'snapshot',
        outcome: 'completed',
      }),
    );
    hooks.transaction.publishStoreSnapshot();
  };
  const dispose = async (): Promise<void> => {
    if (hooks.lifecycle.state === 'disposed') {
      await hooks.lifecycle.quiesce();
      return;
    }
    const previous = hooks.current();
    hooks.lifecycle.dispose(previous.id);
    hooks.emit(
      'controller.disposed',
      hooks.buildDetail('controller.disposed', previous, {
        durability: 'snapshot',
        outcome: 'completed',
      }),
    );
    hooks.transaction.publishStoreSnapshot();
    await hooks.lifecycle.quiesce();
  };
  return { close, complete: close, dispose };
}
