import type { ConversationHistory } from 'conversationalist';
import type { JSONValue } from 'interoperability';
import type { KeyValueStore } from 'storage';

export interface AgentSession {
  id: string;
  agentName: string;
  conversationHistory: ConversationHistory;
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
 * Saves an agent session by serializing it directly to the key-value store.
 */
export async function saveAgentSession(store: KeyValueStore, session: AgentSession): Promise<void> {
  const data = {
    ...session,
    conversationHistory: session.conversationHistory,
    updatedAt: new Date().toISOString(),
  };
  await store.set(`agent-session:${session.id}`, JSON.stringify(data));
}

/**
 * Loads an agent session from a key-value store by id. Returns
 * undefined if no session is found.
 */
export async function loadAgentSession(
  store: KeyValueStore,
  id: string,
): Promise<AgentSession | undefined> {
  const raw = await store.get(`agent-session:${id}`);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      'agentName' in parsed &&
      'conversationHistory' in parsed
    ) {
      return parsed as AgentSession;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
