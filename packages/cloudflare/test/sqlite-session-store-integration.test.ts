import { textValueStore } from '@lostgradient/weft/storage/text-value-store';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { createAgentSession, createSessionStore } from 'operative';

import { createCloudflareSqliteStorage } from '../src/create-cloudflare-sqlite-storage';
import { createSqliteDouble } from '../src/test/sqlite-double';

/**
 * THE HONESTY CHECK: the conformance suites in `sqlite-storage-contract.test.ts`
 * prove `createCloudflareSqliteStorage` satisfies Weft's `Storage` contract, but
 * the acceptance criterion is a *session-store* backend. This wires the exact
 * stack a Worker would use — `createCloudflareSqliteStorage` wrapped by Weft's
 * own `textValueStore()` feeding `operative`'s `createSessionStore` unchanged —
 * and exercises save/load, the compare-and-swap `update()` path, and `list()`.
 */
describe('createCloudflareSqliteStorage backs operative.createSessionStore', () => {
  function makeStore() {
    const sql = createSqliteDouble();
    const storage = createCloudflareSqliteStorage({ sql });
    return createSessionStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
  }

  it('save/load round trip preserves session data', async () => {
    const store = makeStore();
    const session = createAgentSession({
      agentName: 'cloudflare-agent',
      conversationHistory: createConversationHistory(),
    });

    await store.save(session);
    const loaded = await store.load(session.id);

    expect(loaded).toBeDefined();
    expect(loaded!.agentName).toBe('cloudflare-agent');
    expect(loaded!.revision).toBe(1);
  });

  it('update() applies a compare-and-swap mutation against the durable SQLite row', async () => {
    const store = makeStore();
    const session = createAgentSession({
      agentName: 'cas-agent',
      conversationHistory: createConversationHistory(),
    });
    await store.save(session);

    const updated = await store.update(session.id, (current) => {
      if (!current) return undefined;
      const conversation = new Conversation(current.conversationHistory);
      conversation.appendUserMessage('hello from the Workers-native store');
      return { ...current, conversationHistory: conversation.current };
    });

    expect(updated).toBeDefined();
    expect(updated!.conversationHistory.ids.length).toBe(1);

    const reloaded = await store.load(session.id);
    expect(reloaded!.conversationHistory.ids.length).toBe(1);
  });

  it('list() returns saved sessions filtered by agentName', async () => {
    const store = makeStore();
    const sessionA = createAgentSession({
      agentName: 'agent-a',
      conversationHistory: createConversationHistory(),
    });
    const sessionB = createAgentSession({
      agentName: 'agent-b',
      conversationHistory: createConversationHistory(),
    });
    await store.save(sessionA);
    await store.save(sessionB);

    const filtered = await store.list({ agentName: 'agent-a' });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(sessionA.id);
  });

  it('delete() removes a saved session', async () => {
    const store = makeStore();
    const session = createAgentSession({
      agentName: 'to-delete',
      conversationHistory: createConversationHistory(),
    });
    await store.save(session);

    await store.delete(session.id);

    expect(await store.load(session.id)).toBeUndefined();
  });
});
