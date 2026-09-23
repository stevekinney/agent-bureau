import type { ConversationEnvironment } from './environment';
import type { ConversationActionType, ConversationEventDetail } from './events';
import type { ConversationChangeContext } from './history-events';
import type { HistoryNode } from './history-tree';
import type { ConversationHistory, Message } from './types';

type TreeHooks<T> = {
  readonly current: () => ConversationHistory;
  readonly node: () => HistoryNode;
  readonly revision: () => number;
  readonly environment: ConversationEnvironment;
  readonly sourcePlugins: readonly ConversationEnvironment['plugins'][number][];
  readonly assertOpen: () => void;
  readonly navigate: (
    action: 'undo' | 'redo' | 'switch',
    index: number,
  ) => ConversationHistory | undefined;
  readonly commit: (
    next: ConversationHistory,
    action: ConversationActionType,
    events: readonly ConversationActionType[],
  ) => void;
  readonly detail: (
    action: ConversationActionType,
    previous: ConversationHistory,
    context: ConversationChangeContext & Record<string, unknown>,
  ) => ConversationEventDetail;
  readonly emit: (type: string, detail: ConversationEventDetail) => void;
  readonly create: (history: ConversationHistory, environment: ConversationEnvironment) => T;
  readonly setLineage: (
    conversation: T,
    lineage: { parentConversationId: string; forkPointMessageId?: string; sourceRevision: number },
  ) => void;
};

export type TreeActions<T> = {
  readonly push: (next: ConversationHistory) => void;
  readonly undo: () => ConversationHistory | undefined;
  readonly redo: (childIndex?: number) => ConversationHistory | undefined;
  readonly switchToBranch: (index: number) => ConversationHistory | undefined;
  readonly fork: (messageId?: string) => T;
  readonly tag: (label: string) => void;
  readonly rename: (title: string) => void;
  readonly getPath: () => ConversationHistory[];
};

export function createTreeActions<T>(hooks: TreeHooks<T>): TreeActions<T> {
  const navigate = (action: 'undo' | 'redo' | 'switch', index: number) =>
    hooks.navigate(action, index);

  const fork = (messageId?: string): T => {
    hooks.assertOpen();
    const previous = hooks.current();
    const cloned = structuredClone(previous);
    let forkedHistory: ConversationHistory;
    if (messageId) {
      const messageIndex = cloned.ids.indexOf(messageId);
      if (messageIndex === -1) throw new Error(`Message with id "${messageId}" not found`);
      const ids = cloned.ids.slice(0, messageIndex + 1);
      const messages: Record<string, Message> = {};
      for (const id of ids) {
        const message = cloned.messages[id];
        if (message) messages[id] = message;
      }
      forkedHistory = {
        ...cloned,
        id: hooks.environment.randomId(),
        ids,
        messages,
        updatedAt: hooks.environment.now(),
      };
    } else {
      forkedHistory = {
        ...cloned,
        id: hooks.environment.randomId(),
        updatedAt: hooks.environment.now(),
      };
    }
    const forked = hooks.create(forkedHistory, {
      ...hooks.environment,
      plugins: [...hooks.sourcePlugins],
    });
    hooks.setLineage(forked, {
      parentConversationId: previous.id,
      ...(messageId ? { forkPointMessageId: messageId } : {}),
      sourceRevision: hooks.revision(),
    });
    const correlationId = `${previous.id}:fork:${forkedHistory.id}`;
    hooks.emit(
      'session.forked',
      hooks.detail('session.forked', previous, {
        childConversationId: forkedHistory.id,
        durability: 'snapshot',
        correlationId,
      }),
    );
    hooks.emit(
      'change',
      hooks.detail('session.forked', previous, {
        childConversationId: forkedHistory.id,
        durability: 'snapshot',
        correlationId,
      }),
    );
    return forked;
  };

  const tag = (label: string): void => {
    hooks.assertOpen();
    const previous = hooks.current();
    const rawTags = previous.metadata['_tags'];
    const existingTags =
      Array.isArray(rawTags) &&
      rawTags.every((candidate): candidate is string => typeof candidate === 'string')
        ? rawTags
        : [];
    if (existingTags.includes(label)) return;
    hooks.commit(
      {
        ...previous,
        metadata: { ...previous.metadata, _tags: [...existingTags, label] },
        updatedAt: hooks.environment.now(),
      },
      'session.tagged',
      ['push', 'session.tagged'],
    );
  };

  const rename = (title: string): void => {
    hooks.assertOpen();
    const previous = hooks.current();
    if (previous.title === title) return;
    hooks.commit({ ...previous, title, updatedAt: hooks.environment.now() }, 'session.renamed', [
      'push',
      'session.renamed',
    ]);
  };

  return {
    push: (next) => hooks.commit(next, 'push', ['push']),
    undo: () => navigate('undo', 0),
    redo: (childIndex = 0) => navigate('redo', childIndex),
    switchToBranch: (index) => navigate('switch', index),
    fork,
    tag,
    rename,
    getPath: () => {
      const path: ConversationHistory[] = [];
      let node: HistoryNode | null = hooks.node();
      while (node) {
        path.unshift(node.conversation);
        node = node.parent;
      }
      return path;
    },
  };
}
