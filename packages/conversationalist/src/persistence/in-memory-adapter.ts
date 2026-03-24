import type { SessionInfo, SessionPersistenceAdapter } from '../environment';
import type { ConversationHistory } from '../types';

export interface InMemoryPersistenceAdapterOptions {
  initialData?: Map<string, ConversationHistory>;
}

function deepClone(value: ConversationHistory): ConversationHistory {
  return JSON.parse(JSON.stringify(value)) as ConversationHistory;
}

function toSessionInfo(conversation: ConversationHistory): SessionInfo {
  return {
    id: conversation.id,
    ...(conversation.title !== undefined ? { title: conversation.title } : {}),
    tags: (conversation.metadata['_tags'] as string[] | undefined) ?? [],
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.ids.length,
  };
}

export function createInMemoryPersistenceAdapter(
  options?: InMemoryPersistenceAdapterOptions,
): SessionPersistenceAdapter {
  const store = new Map<string, ConversationHistory>();

  if (options?.initialData) {
    for (const [key, value] of options.initialData) {
      store.set(key, deepClone(value));
    }
  }

  return {
    save(conversation: ConversationHistory): Promise<void> {
      store.set(conversation.id, deepClone(conversation));
      return Promise.resolve();
    },

    load(id: string): Promise<ConversationHistory | undefined> {
      const stored = store.get(id);
      if (!stored) return Promise.resolve(undefined);
      return Promise.resolve(deepClone(stored));
    },

    list(): Promise<SessionInfo[]> {
      return Promise.resolve([...store.values()].map(toSessionInfo));
    },

    delete(id: string): Promise<void> {
      store.delete(id);
      return Promise.resolve();
    },
  };
}
