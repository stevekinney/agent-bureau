import { CompletableEventTarget, type Subscription } from '@lostgradient/lifecycle';
import { afterEach } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAgentRun, type AgentRun } from '../agent-run';
import type { ActiveRun } from '../create-run';
import type { CombinedOperativeEventMap, CombinedOperativeEventType } from '../events';
import type { AgentRunLivenessSnapshot } from '../liveness/active-run-liveness';
import { createActiveRunLiveness } from '../liveness/active-run-liveness';
import type { CleanupAcknowledgement, RunResult } from '../types';

const activeMonitorRuns = new Set<AgentRun>();

afterEach(() => {
  for (const run of activeMonitorRuns) run[Symbol.dispose]();
  activeMonitorRuns.clear();
});

export function createMonitorRun(result: Promise<RunResult>): AgentRun {
  const events = new CompletableEventTarget<CombinedOperativeEventMap>();
  const liveness = createActiveRunLiveness({
    id: 'session-monitor-fixture',
    durability: 'process-local',
  });
  const activeRun: ActiveRun = {
    result,
    abort: () => {},
    // COR-1270: a liveness fixture with no hook plan to describe.
    describeHookPlan: () => undefined,
    closed: async (): Promise<CleanupAcknowledgement> => ({ status: 'not-required' }),
    addEventListener: <K extends CombinedOperativeEventType>(
      type: K,
      listener: (event: CombinedOperativeEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ) => events.addEventListener(type, listener, options),
    removeEventListener: <K extends CombinedOperativeEventType>(
      type: K,
      listener: (event: CombinedOperativeEventMap[K]) => void,
      options?: boolean | EventListenerOptions,
    ) => events.removeEventListener(type, listener, options),
    on: <K extends CombinedOperativeEventType>(type: K) => events.on(type),
    once: <K extends CombinedOperativeEventType>(
      type: K,
      listener: (event: CombinedOperativeEventMap[K]) => void,
    ) => events.once(type, listener),
    subscribe: <K extends CombinedOperativeEventType>(
      type: K,
      observerOrNext?:
        | ((value: CombinedOperativeEventMap[K]) => void)
        | { next?: (value: CombinedOperativeEventMap[K]) => void },
      error?: (error: unknown) => void,
      complete?: () => void,
    ): Subscription => events.subscribe(type, observerOrNext, error, complete),
    events: <K extends CombinedOperativeEventType>(
      type: K,
      options?: { signal?: AbortSignal; bufferSize?: number },
    ) => events.events(type, options),
    toObservable: () => events.toObservable(),
    complete: () => events.complete(),
    snapshot: (): AgentRunLivenessSnapshot => liveness.snapshot(),
    subscribeSnapshot: (observer, options) => liveness.subscribeSnapshot(observer, options),
    [Symbol.dispose]: () => {
      liveness.dispose();
      events.complete();
    },
  };
  const run = createAgentRun(activeRun);
  activeMonitorRuns.add(run);
  return run;
}

export function createMonitorResult(finishReason: RunResult['finishReason']): RunResult {
  return {
    conversation: new Conversation(),
    steps: [],
    content: '',
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason,
  };
}
