import type { ConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';

import type { AgentRun, RunEvent } from '../agent-run';
import { createAgentRun } from '../agent-run';
import type { RunRef } from '../agent-session';
import { createClosedAcknowledgement } from '../closed-acknowledgement';
import type { ActiveRun } from '../create-run';
import { reattachDurableActiveRun } from '../durable/active-run-reattach';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import type { CombinedOperativeEventMap, SessionRecoverFailure } from '../events';
import { SessionRecoverEvent } from '../events';
import type { RunOutcome, RunResult } from '../types';
import type { SessionRunOptions } from './session-handle';
import {
  appendRecoveredConversation,
  finishReasonToStatus,
  isTerminalRunEvent,
  reconcileTerminalRunRef,
  runOutcomeFromResult,
} from './session-handle-support';
import type { SessionStore } from './types';
export interface SessionRecoveryState {
  currentRun: AgentRun | null;
  currentRunId: string | null;
}
export interface SessionRecoveryDependencies {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly engine: RegistryAgnosticEngine | undefined;
  readonly checkpointStore: CheckpointStore | undefined;
  readonly runOptions: SessionRunOptions | undefined;
  readonly emitter: EventTarget;
  readonly state: SessionRecoveryState;
}
export function createSessionRecovery(
  dependencies: SessionRecoveryDependencies,
): () => Promise<AgentRun | null> {
  const { sessionId, store, engine, checkpointStore, runOptions, emitter, state } = dependencies;
  return async (): Promise<AgentRun | null> => {
    // Fast path: a run is live in this process (same-process disconnect/reconnect).
    if (state.currentRun !== null) {
      emitter.dispatchEvent(new SessionRecoverEvent(sessionId, null));
      return state.currentRun;
    }
    // Durable re-attach path (D2): when an engine AND checkpointStore are
    // present, check whether any session run is still `'running'` in the
    // durable store. On a crash → restart the bureau re-creates the engine over
    // the SAME store, Weft's `recoverAll()` resumes in-flight workflows on boot,
    // and `engine.resume(runId)` gives a handle to the already-running recovered
    // workflow without starting a new one. Wrap it as an `AgentRun` so the
    // caller can observe the resumed run normally.
    if (engine && checkpointStore) {
      const session = await store.load(sessionId);
      const runningRefs = [...(session?.runs ?? [])]
        .reverse()
        .filter((runRef) => runRef.status === 'running');
      // Every engine.resume() rejection encountered below, keyed by the
      // runId that failed. Reported on the final SessionRecoverEvent so a
      // failed re-attach is distinguishable from the benign "no running
      // refs at all" outcome, which reports the identical runId: null but
      // an empty failures array.
      const failures: SessionRecoverFailure[] = [];
      for (const runningRef of runningRefs) {
        const runId = runningRef.runId;
        try {
          const recoveredHandle = await engine.resume(runId);
          const activeRun = reattachDurableActiveRun(
            { engine, checkpointStore },
            {
              runId,
              handle: recoveredHandle,
              // AB-304: the same registry a fresh run() call threads
              // through `RunOptions.childRegistry` — see the identical
              // reasoning on `reattachDurableActiveRun`'s own
              // `childRegistry` option.
              childRegistry: runOptions?.childRegistry,
            },
          );
          const rawAgentRun = createAgentRun(activeRun);
          const recoveredEventBarrier = new CompletableEventTarget<CombinedOperativeEventMap>();
          const pendingRecoveredTerminalEvents: RunEvent[] = [];
          const recoveredSubscription = activeRun.toObservable().subscribe({
            next: (event) => {
              if (isTerminalRunEvent(event)) pendingRecoveredTerminalEvents.push(event);
              else recoveredEventBarrier.dispatchEvent(event);
            },
          });
          state.currentRunId = runId;
          // Persist terminal state when the recovered run settles, mirroring
          // the conflict-aware update path in run(). Without this the persisted RunRef
          // stays 'running' after a recovered run completes, causing
          // subsequent recover()/signal() calls to target a terminal workflow
          // and leaving conversation history un-updated in the session store.
          const committedResult = (async () => {
            let terminalStatus: RunRef['status'] = 'error';
            let terminalConversation: ConversationHistory | undefined;
            let terminalOutcome: RunOutcome | undefined;
            let settledResult: RunResult | undefined;
            let runError: unknown;
            try {
              const settled = await rawAgentRun.result();
              settledResult = settled;
              terminalStatus = finishReasonToStatus(settled.finishReason);
              terminalConversation = settled.conversation.current;
              terminalOutcome = runOutcomeFromResult(settled);
            } catch (error) {
              runError = error;
              terminalOutcome = { finishReason: 'error' };
              // Recovered run rejected (e.g. engine failure). Leave status 'error';
              // no conversation update — the run never produced a clean result.
            }
            // Reload the session (may have been updated by concurrent activity)
            // and replace the RunRef with its terminal status.
            try {
              const committedSession = await store.update(sessionId, (freshSession) => {
                if (!freshSession) return undefined;
                const currentRef = freshSession.runs.find((run) => run.runId === runId);
                if (!currentRef) return undefined;
                if (currentRef.status !== 'running') {
                  if (
                    currentRef.status !== terminalStatus ||
                    (currentRef.outcome?.finishReason !== undefined &&
                      currentRef.outcome.finishReason !== terminalOutcome?.finishReason)
                  ) {
                    throw new Error(`Run "${runId}" has a conflicting terminal classification.`);
                  }
                }
                const terminalRef: RunRef =
                  currentRef.status !== 'running'
                    ? currentRef
                    : {
                        ...currentRef,
                        status: terminalStatus,
                        outcome: terminalOutcome,
                      };
                return {
                  ...freshSession,
                  ...(terminalConversation !== undefined
                    ? {
                        conversationHistory: appendRecoveredConversation(
                          freshSession.conversationHistory,
                          terminalConversation,
                          currentRef,
                        ),
                      }
                    : {}),
                  runs: freshSession.runs.map((r) => (r.runId === runId ? terminalRef : r)),
                };
              });
              if (committedSession === undefined) {
                throw new Error(
                  `Session "${sessionId}" disappeared before recovered run "${runId}" committed.`,
                );
              }
            } catch (error) {
              recoveredSubscription.unsubscribe();
              recoveredEventBarrier.complete();
              throw error;
            }
            recoveredSubscription.unsubscribe();
            for (const event of pendingRecoveredTerminalEvents) {
              recoveredEventBarrier.dispatchEvent(event);
            }
            recoveredEventBarrier.complete();
            if (runError !== undefined) {
              throw runError instanceof Error ? runError : new Error('Recovered run failed.');
            }
            if (!settledResult)
              throw new Error(`Recovered run "${runId}" settled without a result.`);
            return settledResult;
          })().finally(() => {
            if (state.currentRunId === runId) {
              state.currentRun = null;
              state.currentRunId = null;
            }
          });
          // Build the public handle only after the commit-barrier promise
          // exists. Its inherited methods still delegate to the recovered
          // run, while `result()` and every derived method (`unwrap()` and
          // `output()`) observe the awaited terminal session write.
          const committedActiveRun = Object.create(activeRun) as ActiveRun;
          Object.defineProperty(committedActiveRun, 'result', {
            configurable: true,
            enumerable: true,
            get: () => committedResult,
          });
          Object.defineProperty(committedActiveRun, 'closed', {
            configurable: true,
            enumerable: true,
            value: createClosedAcknowledgement({
              result: committedResult,
              disqualifiesFastPath: () => true,
              hasInFlightWork: () => false,
              resolveOutcome: () => activeRun.closed(),
            }),
          });
          Object.defineProperty(committedActiveRun, 'toObservable', {
            configurable: true,
            enumerable: true,
            value: () => recoveredEventBarrier.toObservable(),
          });
          const agentRun = createAgentRun(committedActiveRun);
          state.currentRun = agentRun;
          // Pass along `failures` accumulated from any NEWER running refs
          // that rejected before this (older) one succeeded — a mixed
          // outcome must still surface those rejections, not just the
          // all-fail case.
          emitter.dispatchEvent(new SessionRecoverEvent(sessionId, runId, failures));
          return agentRun;
        } catch (error) {
          // engine.resume() throws when the run is already terminal or the
          // engine doesn't have it, or when recovery itself is broken (e.g.
          // a malformed resolveWorkflowServices result). Reconcile the
          // persisted RunRef in the terminal case (AB-28) — otherwise it is
          // stranded at 'running' forever, and every later
          // recover()/signal()/update() targets a workflow that is already
          // dead. reconcileTerminalRunRef() is a no-op for an unknown runId
          // or a genuine (non-terminal) failure. Record which runId
          // rejected and why regardless — the caller learns about every
          // rejection via `failures` on the event dispatched below, not
          // just the last one — then try older running refs either way.
          try {
            await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, runningRef);
            failures.push({ runId, error });
          } catch (reconciliationError) {
            failures.push({ runId, error: reconciliationError });
          }
        }
      }
      if (failures.length > 0) {
        emitter.dispatchEvent(new SessionRecoverEvent(sessionId, null, failures));
        return null;
      }
    }
    emitter.dispatchEvent(new SessionRecoverEvent(sessionId, null));
    return null;
  };
}
