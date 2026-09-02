import type { Subscription } from 'lifecycle';

import {
  AGENT_RUN_PROVIDER_TURN_POLICY,
  LIVENESS_POLICY_VERSION,
  TOOL_CALL_POLICY,
} from './policies';
import type {
  LivenessAssessment,
  LivenessEvidenceEntry,
  LivenessEvidenceSource,
  LivenessLifecycleStatus,
  LivenessObservable,
  LivenessProgressState,
  LivenessReachability,
  LivenessSnapshot,
} from './types';
import { createStallWatchdog, type StallWatchdog, type StallWatchdogClock } from './watchdog';

export type AgentRunLivenessSnapshot = LivenessSnapshot & { kind: 'agent-run' };

export interface ActiveRunLivenessOptions {
  readonly id: string;
  readonly durability: 'process-local' | 'durable';
  readonly clock?: StallWatchdogClock;
}

/**
 * The `LivenessObservable` implementation shared by every `ActiveRun`
 * constructor (`createActiveRun`, `createDurableActiveRun`,
 * `reattachDurableActiveRun`) — one implementation, per the repository's No
 * Duplicated Code rule, wired into each constructor's own emitter/result
 * plumbing rather than reimplemented per constructor.
 *
 * Aggregates two `createStallWatchdog` instances (AB-88's AC7 rows for
 * `agent-run.provider-turn` and `tool-call`) into a single agent-run-level
 * `LivenessSnapshot`: the worse of the two governs `reachability`/
 * `progress`/`missedPulseCount`, and their evidence merges chronologically.
 *
 * `subscribeSnapshot` pushes a new snapshot to every subscriber on each
 * explicit revision-advancing call (`recordProviderPulse`,
 * `recordToolProgressPulse`, `setStatus`, `setResult`) — not on pure elapsed
 * time with no new evidence. A caller wanting up-to-the-millisecond
 * staleness without a driving event calls `snapshot()` directly, which
 * always recomputes from the watchdogs' current state.
 */
export interface ActiveRunLiveness extends LivenessObservable<AgentRunLivenessSnapshot> {
  recordProviderPulse(detail?: unknown): void;
  recordToolProgressPulse(
    detail?: { toolCallId?: string; toolName?: string } & Record<string, unknown>,
  ): void;
  setStatus(status: LivenessLifecycleStatus): void;
  setResult(result: unknown): void;
  dispose(): void;
}

function worstReachability(a: LivenessReachability, b: LivenessReachability): LivenessReachability {
  // Only 'unknown', 'reachable', 'late', and 'unreachable' are ever produced
  // by createStallWatchdog's assess(); 'not-applicable' is a terminal-only
  // value this aggregation never sees.
  const rank: LivenessReachability[] = ['reachable', 'late', 'unreachable'];
  const ra = rank.indexOf(a);
  const rb = rank.indexOf(b);
  if (ra === -1) return b;
  if (rb === -1) return a;
  return rank[Math.max(ra, rb)] as LivenessReachability;
}

function worstProgress(a: LivenessProgressState, b: LivenessProgressState): LivenessProgressState {
  const rank: LivenessProgressState[] = ['progressing', 'idle', 'stalled'];
  const ra = rank.indexOf(a);
  const rb = rank.indexOf(b);
  if (ra === -1) return b;
  if (rb === -1) return a;
  return rank[Math.max(ra, rb)] as LivenessProgressState;
}

function lastAt(
  evidence: readonly LivenessEvidenceEntry[],
  sources: readonly LivenessEvidenceSource[],
): number | undefined {
  let result: number | undefined;
  for (const entry of evidence) {
    if (sources.includes(entry.source) && (result === undefined || entry.at > result)) {
      result = entry.at;
    }
  }
  return result;
}

function deriveAssessment(
  status: LivenessLifecycleStatus,
  reachability: LivenessReachability,
  progress: LivenessProgressState,
): LivenessAssessment {
  if (status === 'terminal') return 'terminal';
  if (status === 'aborting') return 'aborting';
  if (status === 'cleaning-up') return 'cleaning-up';
  if (reachability === 'unreachable') return 'unreachable';
  if (status === 'waiting') return 'legitimately-waiting';
  if (progress === 'stalled') return 'alive-but-stalled';
  return 'healthy';
}

const realClock: StallWatchdogClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createActiveRunLiveness(options: ActiveRunLivenessOptions): ActiveRunLiveness {
  const clock = options.clock ?? realClock;
  const agentWatchdog: StallWatchdog = createStallWatchdog(AGENT_RUN_PROVIDER_TURN_POLICY, clock);
  const toolWatchdog: StallWatchdog = createStallWatchdog(TOOL_CALL_POLICY, clock);

  const startedAt = new Date().toISOString();
  let revision = 0;
  let status: LivenessLifecycleStatus = 'running';
  let lastTransitionAt = startedAt;
  let result: unknown;
  let hasResult = false;
  let disposed = false;

  const subscribers = new Set<(snapshot: AgentRunLivenessSnapshot) => void>();

  function buildSnapshot(): AgentRunLivenessSnapshot {
    const agentAssessment = agentWatchdog.assess();
    const toolAssessment = toolWatchdog.assess();
    const reachability = worstReachability(
      agentAssessment.reachability,
      toolAssessment.reachability,
    );
    const progress = worstProgress(agentAssessment.progress, toolAssessment.progress);
    const missedPulseCount = Math.max(
      agentAssessment.missedPulseCount,
      toolAssessment.missedPulseCount,
    );
    const evidence = [...agentAssessment.evidence, ...toolAssessment.evidence].sort(
      (a, b) => a.at - b.at,
    );

    const lastHeartbeatAt = lastAt(evidence, [
      'host-reachability',
      'transport-keepalive',
      'provider-io',
      'tool-progress',
      'worker-session-heartbeat',
      'task-attempt-heartbeat',
    ]);
    const lastActivityAt = lastAt(evidence, [
      'provider-io',
      'tool-progress',
      'worker-session-heartbeat',
      'task-attempt-heartbeat',
    ]);
    const lastProgressAt = lastAt(evidence, ['tool-progress']);

    return {
      id: options.id,
      kind: 'agent-run',
      startedAt,
      revision,
      status,
      lastTransitionAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: options.durability,
      cancellable: status !== 'terminal' && status !== 'aborting',
      ...(hasResult ? { result } : {}),
      attempt: 0,
      reachability,
      progress,
      assessment: deriveAssessment(status, reachability, progress),
      observedAt: clock.now(),
      ...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
      missedPulseCount,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence,
    };
  }

  function notify(): void {
    if (disposed && status !== 'terminal') return;
    const snapshot = buildSnapshot();
    for (const subscriber of [...subscribers]) {
      subscriber(snapshot);
    }
    if (status === 'terminal') {
      // Already-terminal work delivers one terminal snapshot and no further
      // calls — clear every subscriber after this final broadcast.
      subscribers.clear();
    }
  }

  function advance(): void {
    revision += 1;
    notify();
  }

  function disposeWatchdogs(): void {
    if (disposed) return;
    disposed = true;
    agentWatchdog.dispose();
    toolWatchdog.dispose();
  }

  return {
    recordProviderPulse(detail?: unknown): void {
      if (disposed) return;
      agentWatchdog.recordPulse('provider-io', 0, detail);
      advance();
    },

    recordToolProgressPulse(
      detail?: { toolCallId?: string; toolName?: string } & Record<string, unknown>,
    ): void {
      if (disposed) return;
      toolWatchdog.recordPulse('tool-progress', 0, detail);
      advance();
    },

    setStatus(next: LivenessLifecycleStatus): void {
      if (status === 'terminal') return;
      if (status === next) return;
      status = next;
      lastTransitionAt = new Date().toISOString();
      if (next === 'terminal') {
        disposeWatchdogs();
      }
      advance();
    },

    setResult(value: unknown): void {
      result = value;
      hasResult = true;
      advance();
    },

    snapshot(): AgentRunLivenessSnapshot {
      return buildSnapshot();
    },

    subscribeSnapshot(
      observer: (snapshot: AgentRunLivenessSnapshot) => void,
      subscribeOptions?: { signal?: AbortSignal },
    ): Subscription {
      let closed = false;
      observer(buildSnapshot());

      if (status !== 'terminal') {
        subscribers.add(observer);
      }

      function unsubscribe(): void {
        if (closed) return;
        closed = true;
        subscribers.delete(observer);
      }

      subscribeOptions?.signal?.addEventListener('abort', unsubscribe, { once: true });

      return {
        unsubscribe,
        get closed() {
          return closed;
        },
      };
    },

    dispose: disposeWatchdogs,
  };
}
