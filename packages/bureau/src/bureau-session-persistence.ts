import type { AgentSession, JSONValue, SessionStore, Store } from '@lostgradient/operative';
import { createAgentSession } from '@lostgradient/operative';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';

import { isPlainAuthorityRecord } from './session-authority';
import type { DiagnosticSink } from './types';

const BUREAU_AGENT_NAME = 'bureau';
const SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS = 3;

export interface SessionPersistenceDependencies {
  readonly sessionStore: Pick<SessionStore, 'load' | 'update'> | undefined;
  readonly orphanedRunIds: Set<string>;
  readonly store: Pick<Store, 'getRun'>;
  readonly retryDelayMilliseconds: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly diagnose: DiagnosticSink;
  readonly serializeError: (error: unknown) => string;
}

function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendConversationMessages(
  current: ConversationHistory,
  candidate: ConversationHistory,
  base: ConversationHistory,
): ConversationHistory {
  const baseIds = new Set(base.ids);
  const candidateIds = new Set(candidate.ids);
  const currentIds = new Set(current.ids);
  const currentPreservedIds = current.ids.filter((id) => candidateIds.has(id) || !baseIds.has(id));
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...currentPreservedIds, ...candidateOnlyIds];
  const messages: Record<string, ConversationHistory['messages'][string]> = {};

  for (const id of ids) {
    const candidateMessage = candidate.messages[id];
    const baseMessage = base.messages[id];
    const message =
      candidateMessage &&
      (!baseMessage || !messagesAreEqual(candidateMessage, baseMessage) || !current.messages[id])
        ? candidateMessage
        : (current.messages[id] ?? candidateMessage);
    if (message) messages[id] = message;
  }

  for (const [position, id] of ids.entries()) {
    const message = messages[id];
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    metadata: { ...current.metadata, ...candidate.metadata },
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}

function omitKeysWithPrefix(
  record: Record<string, JSONValue>,
  prefix: string,
): Record<string, JSONValue> {
  const remaining: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) remaining[key] = value;
  }
  return remaining;
}

function enumerableRecord(
  value: JSONValue | undefined,
  includeArrays: boolean,
): Record<string, JSONValue> {
  if (isPlainAuthorityRecord(value)) return value;
  if (includeArrays && Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  if (includeArrays && typeof value === 'string') {
    return Object.fromEntries(Object.entries(value));
  }
  return {};
}

function mergeMetadata(
  current: Record<string, JSONValue>,
  metadata: Record<string, JSONValue>,
): Record<string, JSONValue> {
  // Ownership maps remain durable after a run reaches a terminal state so
  // event-history authorization can resolve retained history. Maintenance,
  // rather than this write path, prunes entries below the retention floor.
  return {
    ...current,
    ...metadata,
    ...(metadata['lastRequestAuthorities'] !== undefined
      ? {
          lastRequestAuthorities: {
            ...enumerableRecord(current['lastRequestAuthorities'], false),
            ...enumerableRecord(metadata['lastRequestAuthorities'], true),
          },
        }
      : {}),
    ...(metadata['lastRunOwningPrincipals'] !== undefined
      ? {
          lastRunOwningPrincipals: {
            ...enumerableRecord(current['lastRunOwningPrincipals'], false),
            ...enumerableRecord(metadata['lastRunOwningPrincipals'], true),
          },
        }
      : {}),
  };
}

function clearTerminalApprovalMetadata(
  metadata: Record<string, JSONValue>,
  runId: string,
  hasPendingApproval: boolean,
): void {
  // A terminal action-required run can still have a live approval review.
  // Retain its authority and approval descriptor until that review resolves.
  if (hasPendingApproval) return;
  if (isPlainAuthorityRecord(metadata['lastRequestAuthorities'])) {
    const { [runId]: _removed, ...remainingAuthorities } = metadata['lastRequestAuthorities'];
    metadata['lastRequestAuthorities'] = remainingAuthorities;
  }
  if (isPlainAuthorityRecord(metadata['pendingApprovalOverrides'])) {
    metadata['pendingApprovalOverrides'] = omitKeysWithPrefix(
      metadata['pendingApprovalOverrides'],
      `approval:${runId}:`,
    );
  }
}

function clearCompletedRunMetadata(
  metadata: Record<string, JSONValue>,
  store: Pick<Store, 'getRun'>,
): void {
  const runId = metadata['lastRunId'];
  const status = metadata['lastRunStatus'];
  if (
    typeof runId !== 'string' ||
    (status !== 'completed' && status !== 'aborted' && status !== 'error')
  ) {
    return;
  }
  const hasPendingApproval = store
    .getRun(runId)
    ?.steps.some((step) =>
      step.results.some(
        (result) => result.outcome === 'action_required' && result.pendingApproval !== undefined,
      ),
    );
  clearTerminalApprovalMetadata(metadata, runId, hasPendingApproval ?? false);
}

export function createSessionPersistence(dependencies: SessionPersistenceDependencies) {
  const {
    sessionStore,
    orphanedRunIds,
    store,
    retryDelayMilliseconds,
    sleep,
    diagnose,
    serializeError,
  } = dependencies;

  async function loadConversation(sessionId: string) {
    if (!sessionStore) {
      return {
        session: undefined,
        conversation: new Conversation(createConversationHistory({ id: sessionId })),
      };
    }

    const session = await sessionStore.load(sessionId);
    return {
      session,
      conversation: new Conversation(
        session?.conversationHistory ?? createConversationHistory({ id: sessionId }),
      ),
    };
  }

  async function saveSession(
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
    agentName?: string,
    baseConversationHistory: ConversationHistory = conversation.current,
  ): Promise<void> {
    if (!sessionStore) return;
    const candidateRunId = metadata['lastRunId'];
    if (typeof candidateRunId === 'string' && orphanedRunIds.delete(candidateRunId)) return;

    await sessionStore.update(sessionId, (existingSession: AgentSession | undefined) => {
      const nextSession =
        existingSession ??
        createAgentSession({
          id: sessionId,
          agentName: agentName ?? BUREAU_AGENT_NAME,
          conversationHistory: conversation.current,
        });
      const resolvedAgentName =
        agentName !== undefined && nextSession.agentName === BUREAU_AGENT_NAME
          ? agentName
          : nextSession.agentName;
      const mergedMetadata = mergeMetadata(nextSession.metadata, metadata);
      clearCompletedRunMetadata(mergedMetadata, store);

      return {
        ...nextSession,
        agentName: resolvedAgentName,
        conversationHistory: existingSession
          ? appendConversationMessages(
              existingSession.conversationHistory,
              conversation.current,
              baseConversationHistory,
            )
          : conversation.current,
        metadata: mergedMetadata,
      };
    });
  }

  function persistSessionUpdate(
    saveSessionUpdate: () => Promise<void>,
    context: { runId: string; sessionId: string; status: 'completed' | 'error' | 'aborted' },
  ): void {
    void (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
        try {
          await saveSessionUpdate();
          return;
        } catch (error) {
          lastError = error;
          if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
            try {
              await sleep(retryDelayMilliseconds);
            } catch (sleepError) {
              lastError = sleepError;
              break;
            }
          }
        }
      }
      diagnose({
        level: 'error',
        scope: 'session-persistence',
        message: `[bureau] Failed to persist ${context.status} session state for run ${context.runId} in session ${context.sessionId}: ${serializeError(lastError)}`,
      });
    })();
  }

  return { loadConversation, saveSession, persistSessionUpdate };
}
