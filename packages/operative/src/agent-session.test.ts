import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession, loadAgentSession, saveAgentSession } from './agent-session';

describe('agent session persistence helpers', () => {
  it('loadAgentSession normalizes legacy sessions before saveAgentSession merges them', async () => {
    const store = textValueStore(new MemoryStorage());
    const session = createAgentSession({
      agentName: 'legacy-agent',
      conversationHistory: createConversationHistory(),
      id: 'legacy-helper-session',
    });
    const { metadata: _metadata, revision: _revision, runs: _runs, ...legacyPayload } = session;
    await store.set(`agent-session:${session.id}`, JSON.stringify(legacyPayload));

    const loaded = await loadAgentSession(store, session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.metadata).toEqual({});
    expect(loaded!.revision).toBe(0);
    expect(loaded!.runs).toEqual([]);

    const conversation = new Conversation(loaded!.conversationHistory);
    conversation.appendUserMessage('legacy helper writer');

    await saveAgentSession(store, {
      ...loaded!,
      conversationHistory: conversation.current,
    });

    const saved = await loadAgentSession(store, session.id);
    expect(saved).toBeDefined();
    expect(saved!.revision).toBe(1);
    expect(saved!.runs).toEqual([]);
    expect(
      saved!.conversationHistory.ids.map((id) => saved!.conversationHistory.messages[id]!.content),
    ).toEqual(['legacy helper writer']);
  });
});
