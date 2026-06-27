import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import type { ConversationHistory } from 'conversationalist';
import type { JSONValue } from 'interoperability';

import { createSessionStore } from './session/create-session-store';

/**
 * A lightweight reference to one run within a session.
 * `runId` is derived as `${sessionId}:${sequence}` — self-describing and
 * unambiguous. A recovered workflow id reveals its session + sequence with
 * no side-table lookup.
 *
 * F2: `agentName` is carried on the ref so a session worked by a SEQUENCE
 * of different agents (via handoff) retains a full audit trail of which
 * agent ran each run.
 */
export interface RunRef {
  /** Derived run id: `${sessionId}:${sequence}`. */
  runId: string;
  /**
   * Monotonic sequence within the session (0-based). Equals the run's index
   * in the session's `runs` array.
   */
  sequence: number;
  /** Terminal or in-progress status, persisted so recovery can check it. */
  status: 'running' | 'completed' | 'error' | 'aborted';
  /** ISO timestamp when this run was started. */
  startedAt: string;
  /**
   * The name of the agent that ran this run.
   *
   * Carrying agentName on each RunRef (F2) enables a session to be worked
   * by a SEQUENCE of different agents over time (e.g. via handoff) while
   * preserving a full audit trail of which agent handled each run.
   */
  agentName: string;
}

export interface AgentSession {
  id: string;
  agentName: string;
  conversationHistory: ConversationHistory;
  /**
   * Optimistic-concurrency revision. New in-memory sessions start at 0; each
   * successful SessionStore write increments the persisted revision.
   */
  revision: number;
  /**
   * Ordered sequence of run references. Each `run(input)` appends a new entry;
   * the session is the durable aggregate, runs are the ordered sequence within it.
   * `runId = ${sessionId}:${sequence}` — derived, never supplied by the caller.
   */
  runs: RunRef[];
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
  runs?: RunRef[];
}): AgentSession {
  const now = new Date().toISOString();
  return {
    id: options.id ?? crypto.randomUUID(),
    agentName: options.agentName,
    conversationHistory: options.conversationHistory,
    revision: 0,
    runs: options.runs ?? [],
    metadata: options.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Saves an agent session through the conflict-aware SessionStore path.
 */
export async function saveAgentSession(
  store: ConditionalTextValueStore,
  session: AgentSession,
): Promise<void> {
  await createSessionStore(store).save(session);
}

/**
 * Loads an agent session from a key-value store by id. Returns
 * undefined if no session is found.
 */
export async function loadAgentSession(
  store: ConditionalTextValueStore,
  id: string,
): Promise<AgentSession | undefined> {
  const raw = await store.get(`agent-session:${id}`);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = parsed as Record<string, unknown>;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      'agentName' in parsed &&
      'conversationHistory' in parsed
    ) {
      return {
        ...(parsed as AgentSession),
        metadata:
          typeof record['metadata'] === 'object' &&
          record['metadata'] !== null &&
          !Array.isArray(record['metadata'])
            ? (record['metadata'] as Record<string, JSONValue>)
            : {},
        revision:
          typeof record['revision'] === 'number'
            ? ((record as Record<string, number>)['revision'] ?? 0)
            : 0,
        runs: Array.isArray(record['runs']) ? (record['runs'] as RunRef[]) : [],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
