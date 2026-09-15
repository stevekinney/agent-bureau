import type { WorkflowState } from '@lostgradient/weft';
import type { ConversationHistory } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';
import type { RuntimeServices } from 'lifecycle';

import type { RunEvent } from '../agent-run';
import type { AgentSession, RunRef } from '../agent-session';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import { normalizeAgentRunWorkflowResult } from '../durable/run-workflow-result';
import { toAgentRunError } from '../errors';
import type { RunOutcome, RunResult } from '../types';
import type { SessionStore } from './types';

export function historyOrEmpty(
  history: ConversationHistory | undefined,
  runtime: RuntimeServices,
): ConversationHistory {
  // AB-321: forwards the resolved runtime into the fresh history's own
  // environment seam — only relevant on the `undefined` branch, since an
  // existing `history`'s id is untouched either way.
  return history ?? createConversationHistory(undefined, { runtime });
}

function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function metadataValuesAreEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeConversationMetadata(
  current: ConversationHistory['metadata'],
  candidate: ConversationHistory['metadata'],
  base: ConversationHistory['metadata'],
): ConversationHistory['metadata'] {
  const merged = { ...current };
  const keys = new Set([...Object.keys(base), ...Object.keys(candidate)]);
  for (const key of keys) {
    const baseHasKey = Object.prototype.hasOwnProperty.call(base, key);
    const candidateHasKey = Object.prototype.hasOwnProperty.call(candidate, key);
    if (
      baseHasKey === candidateHasKey &&
      (!baseHasKey || metadataValuesAreEqual(base[key], candidate[key]))
    ) {
      continue;
    }
    if (!candidateHasKey) {
      delete merged[key];
    } else {
      const candidateValue = candidate[key];
      if (candidateValue !== undefined) merged[key] = candidateValue;
    }
  }
  return merged;
}

export function appendConversationMessages(
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
    metadata: mergeConversationMetadata(current.metadata, candidate.metadata, base.metadata),
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}

/**
 * Merge a recovered terminal transcript into the current session body.
 * Message reconciliation keeps current edits for known rows and appends
 * missing candidate rows. A running ref's reservation metadata supplies the
 * three-way baseline; legacy refs have no provenance, so current metadata wins
 * and only candidate-only additions are observable and applied. A ref already
 * terminal is authoritative for metadata and keeps current accepted edits.
 */
export function appendRecoveredConversation(
  current: ConversationHistory,
  candidate: ConversationHistory,
  runRef: RunRef,
): ConversationHistory {
  const merged = appendConversationMessages(current, candidate, candidate);
  if (runRef.status !== 'running') return merged;

  const baseMetadata = runRef.baseConversationMetadata;
  if (baseMetadata === undefined) {
    const metadata = { ...current.metadata };
    for (const [key, value] of Object.entries(candidate.metadata)) {
      if (!Object.prototype.hasOwnProperty.call(current.metadata, key) && value !== undefined) {
        metadata[key] = value;
      }
    }
    return { ...merged, metadata };
  }

  return {
    ...merged,
    metadata: mergeConversationMetadata(current.metadata, candidate.metadata, baseMetadata),
  };
}

export function newestRunningRunRef(session: AgentSession | undefined): RunRef | undefined {
  return [...(session?.runs ?? [])].reverse().find((runRef) => runRef.status === 'running');
}

/**
 * Map a `finishReason` to a `RunRef.status`.
 */
export function finishReasonToStatus(finishReason: string): RunRef['status'] {
  if (finishReason === 'aborted') return 'aborted';
  if (
    finishReason === 'error' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded' ||
    finishReason === 'tripwire'
  ) {
    return 'error';
  }
  return 'completed';
}

export function runOutcomeFromResult(result: RunResult): RunOutcome {
  const error =
    result.error !== undefined
      ? toAgentRunError(result.error)
      : result.schemaValidation?.success === false
        ? { kind: 'output' as const, code: 'INVALID_OUTPUT' as const }
        : undefined;
  return {
    finishReason: result.finishReason,
    ...(error ? { error: { kind: error.kind, code: error.code } } : {}),
  };
}

export function isTerminalRunEvent(event: RunEvent): boolean {
  return (
    event.type === 'run.completed' || event.type === 'run.error' || event.type === 'run.aborted'
  );
}

/**
 * Map a genuine Weft-level terminal `WorkflowStatus` — one reached WITHOUT the
 * `agentRun` workflow ever returning an {@link AgentRunWorkflowResult} (a real
 * engine failure, an operator/adapter cancellation, or a circuit-breaker /
 * deadline timeout) — to the matching `RunRef` status. `run-workflow.ts`
 * always RETURNS normally, even for an operative-level failure (it encodes
 * that in `finishReason`, see `finishReasonToStatus`), so this only fires for
 * a failure the workflow itself could not have produced.
 */
function engineStatusToRunRefStatus(
  status: 'failed' | 'cancelled' | 'timed-out',
): RunRef['status'] {
  return status === 'cancelled' ? 'aborted' : 'error';
}

/**
 * Load a terminal run's conversation history straight from its checkpoint,
 * without resuming it. Returns `undefined` when no transcript was ever
 * checkpointed (e.g. the run failed before its first step) or the checkpoint
 * read fails — mirroring the "tolerate a missing conversation" behavior of
 * the settle path in `recover()`'s success branch.
 */
async function loadTerminalConversationHistory(
  checkpointStore: CheckpointStore | undefined,
  runId: string,
): Promise<ConversationHistory | undefined> {
  if (!checkpointStore) return undefined;
  try {
    const checkpoint = await checkpointStore.loadCheckpoint(runId);
    if (checkpoint.conversation === null) return undefined;
    return Conversation.from(checkpoint.conversation).current;
  } catch {
    return undefined;
  }
}

/**
 * Read a terminal run's outcome (status + conversation) directly from the
 * engine/checkpoint store, WITHOUT resuming it (AB-28). Used when
 * `engine.resume(runId)` rejects: that rejection means either the workflow is
 * already terminal, or the engine has no record of it at all — `engine.get()`
 * distinguishes the two (it never throws for a terminal run, and returns
 * `null` for an unknown one), so only a genuinely terminal run is reconciled.
 *
 * Returns `null` when the engine has no record of this workflow (an unknown
 * runId must NOT be marked terminal) or when `engine.get()` reports it as
 * still non-terminal (`resume()` should have succeeded in that case — leave
 * the RunRef alone rather than guessing at a status).
 */
async function readTerminalRunOutcome(
  engine: RegistryAgnosticEngine,
  checkpointStore: CheckpointStore | undefined,
  runId: string,
): Promise<{
  status: RunRef['status'];
  conversation?: ConversationHistory;
  outcome?: RunOutcome;
} | null> {
  let state: WorkflowState | null;
  try {
    state = await engine.get(runId);
  } catch {
    return null;
  }
  if (!state) return null;
  if (state.status === 'pending' || state.status === 'running' || state.status === 'suspended') {
    return null;
  }

  const conversation = await loadTerminalConversationHistory(checkpointStore, runId);

  if (state.status !== 'completed') {
    return {
      status: engineStatusToRunRefStatus(state.status),
      conversation,
      outcome: {
        finishReason: state.status === 'cancelled' ? 'aborted' : 'error',
      },
    };
  }

  // The workflow's own declared return type — the same trusted-internal-
  // contract cast `active-run-adapter.ts` makes after `handle.result()`.
  const summary = normalizeAgentRunWorkflowResult(state.result);
  return {
    status: finishReasonToStatus(summary.finishReason),
    conversation,
    outcome: {
      finishReason: summary.finishReason,
      ...(summary.errorKind !== undefined && summary.errorCode !== undefined
        ? { error: { kind: summary.errorKind, code: summary.errorCode } }
        : summary.schemaValidation?.success === false
          ? { error: { kind: 'output', code: 'INVALID_OUTPUT' } }
          : {}),
    },
  };
}

/**
 * Reconcile a stranded 'running' `RunRef` whose durable workflow already
 * reached a terminal state before `recover()` could resume it (AB-28) —
 * closing the gap the terminal-status write below (`recover()`'s success
 * branch) does not cover, and the gap left by a store failure in that same
 * write. Mirrors that write's conflict-aware `store.update` + conversation-
 * history reconciliation exactly, so a stranded session converges the same
 * way a live recovered run does.
 *
 * Idempotent: re-checks the ref's status inside the updater, so a session
 * already reconciled by a prior `recover()` call (or a concurrent one) is
 * left untouched rather than reprocessed.
 */
export async function reconcileTerminalRunRef(
  store: SessionStore,
  engine: RegistryAgnosticEngine,
  checkpointStore: CheckpointStore | undefined,
  sessionId: string,
  runningRef: RunRef,
): Promise<void> {
  const outcome = await readTerminalRunOutcome(engine, checkpointStore, runningRef.runId);
  if (!outcome) return;

  const committed = await store.update(sessionId, (freshSession) => {
    if (!freshSession) return undefined;
    const current = freshSession.runs.find((r) => r.runId === runningRef.runId);
    if (!current) return undefined;
    if (current.status !== 'running') return freshSession;
    const terminalRef: RunRef = {
      ...current,
      status: outcome.status,
      ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : {}),
    };
    return {
      ...freshSession,
      ...(outcome.conversation !== undefined
        ? {
            conversationHistory: appendRecoveredConversation(
              freshSession.conversationHistory,
              outcome.conversation,
              current,
            ),
          }
        : {}),
      runs: freshSession.runs.map((r) => (r.runId === runningRef.runId ? terminalRef : r)),
    };
  });
  if (committed === undefined) {
    throw new Error(
      `Session "${sessionId}" disappeared while reconciling run "${runningRef.runId}".`,
    );
  }
}
