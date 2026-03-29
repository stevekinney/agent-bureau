import type { Conversation as ConversationType } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';
import type { JSONValue } from 'interoperability';

import type { AgentSession } from '../agent-session';
import { createAgentSession } from '../agent-session';
import type { SessionStore } from './types';

/**
 * Options for resuming (or creating) a session.
 */
export interface ResumeSessionOptions {
  agentName: string;
  metadata?: Record<string, JSONValue>;
}

/**
 * The result of a resume operation, containing the session, a hydrated
 * Conversation instance, and a flag indicating whether a new session
 * was created.
 */
export interface ResumeSessionResult {
  session: AgentSession;
  conversation: ConversationType;
  isNew: boolean;
}

/**
 * Loads an existing session from the store and restores its conversation
 * history, or creates a brand-new session when the given id is not found
 * (or the stored data is corrupted).
 */
export async function resumeSession(
  store: SessionStore,
  sessionId: string,
  options: ResumeSessionOptions,
): Promise<ResumeSessionResult> {
  const existing = await store.load(sessionId);

  if (existing) {
    const conversation = new Conversation(existing.conversationHistory);
    return {
      session: existing,
      conversation,
      isNew: false,
    };
  }

  // No existing session found (or data was corrupt and load returned undefined).
  // Create a fresh session.
  const session = createAgentSession({
    agentName: options.agentName,
    conversationHistory: createConversationHistory(),
    id: sessionId,
    metadata: options.metadata,
  });

  const conversation = new Conversation(session.conversationHistory);

  return {
    session,
    conversation,
    isNew: true,
  };
}
