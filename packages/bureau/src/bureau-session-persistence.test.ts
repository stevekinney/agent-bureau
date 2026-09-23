import {
  createAgentSession,
  type AgentSession,
  type JSONValue,
  type SessionStore,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createSessionPersistence } from './bureau-session-persistence';

describe('createSessionPersistence', () => {
  it('matches native object-spread semantics for malformed incoming strings and arrays', async () => {
    let storedSession: AgentSession | undefined = createAgentSession({
      id: 'session-merge',
      agentName: 'bureau',
      conversationHistory: createConversationHistory({ id: 'session-merge' }),
      metadata: {
        lastRequestAuthorities: { existing: 'keep' },
        lastRunOwningPrincipals: { existing: 'keep' },
      },
    });
    const sessionStore: Pick<SessionStore, 'load' | 'update'> = {
      load: async () => storedSession,
      update: async (_id, updater) => {
        storedSession = (await updater(storedSession)) ?? undefined;
        return storedSession;
      },
    };
    const persistence = createSessionPersistence({
      sessionStore,
      orphanedRunIds: new Set(),
      store: { getRun: () => undefined },
      retryDelayMilliseconds: 1,
      sleep: async () => {},
      diagnose: () => {},
      serializeError: String,
    });
    const incomingOwners: JSONValue[] = [];
    incomingOwners[2] = 'sparse';
    Object.defineProperty(incomingOwners, 'extra', { value: 'extra', enumerable: true });
    const conversation = new Conversation(createConversationHistory({ id: 'session-merge' }));

    await persistence.saveSession('session-merge', conversation, {
      lastRequestAuthorities: '😀',
      lastRunOwningPrincipals: incomingOwners,
    });

    expect(storedSession?.metadata['lastRequestAuthorities']).toEqual(
      Object.assign({}, { existing: 'keep' }, '😀'),
    );
    expect(storedSession?.metadata['lastRunOwningPrincipals']).toEqual(
      Object.assign({}, { existing: 'keep' }, incomingOwners),
    );
  });
});
