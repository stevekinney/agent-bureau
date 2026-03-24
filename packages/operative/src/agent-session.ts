import type { ConversationHistory, SessionPersistenceAdapter } from 'conversationalist';
import type { JSONValue } from 'interoperability';

export interface AgentSession {
  id: string;
  agentName: string;
  conversationHistory: ConversationHistory;
  metadata: Record<string, JSONValue>;
  createdAt: string;
  updatedAt: string;
}

interface AgentSessionData {
  id: string;
  agentName: string;
  metadata: Record<string, JSONValue>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates a new agent session object. If no id is provided, generates one
 * via crypto.randomUUID(). Timestamps default to the current time.
 */
export function createAgentSession(options: {
  agentName: string;
  conversationHistory: ConversationHistory;
  metadata?: Record<string, JSONValue>;
  id?: string;
}): AgentSession {
  const now = new Date().toISOString();
  return {
    id: options.id ?? crypto.randomUUID(),
    agentName: options.agentName,
    conversationHistory: options.conversationHistory,
    metadata: options.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Saves an agent session by embedding session data into the conversation
 * history's metadata under the `_agentSession` key, then persisting via
 * the adapter.
 */
export async function saveAgentSession(
  adapter: SessionPersistenceAdapter,
  session: AgentSession,
): Promise<void> {
  const historyToSave: ConversationHistory = {
    ...session.conversationHistory,
    metadata: {
      ...session.conversationHistory.metadata,
      _agentSession: {
        id: session.id,
        agentName: session.agentName,
        metadata: session.metadata,
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
      } as unknown as JSONValue,
    },
  };
  await adapter.save(historyToSave);
}

/**
 * Loads an agent session from a persistence adapter by id. Returns
 * undefined if no conversation is found or if the stored conversation
 * does not contain `_agentSession` metadata.
 */
export async function loadAgentSession(
  adapter: SessionPersistenceAdapter,
  id: string,
): Promise<AgentSession | undefined> {
  const history = await adapter.load(id);
  if (!history) return undefined;

  const sessionData = history.metadata['_agentSession'] as AgentSessionData | undefined;
  if (!sessionData) return undefined;

  return {
    id: sessionData.id,
    agentName: sessionData.agentName,
    conversationHistory: history,
    metadata: sessionData.metadata,
    createdAt: sessionData.createdAt,
    updatedAt: sessionData.updatedAt,
  };
}
