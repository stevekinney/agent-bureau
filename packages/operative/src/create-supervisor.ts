import type { EventMap, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget } from 'lifecycle';

import type { AgentRegistry, AgentRegistryEntry } from './create-agent-registry';
import type { RunResult } from './types';

export interface SupervisorTaskResult {
  task: string;
  agentName: string;
  result?: RunResult;
  error?: unknown;
}

export interface SupervisorResult {
  task: string;
  agentResults: SupervisorTaskResult[];
  synthesis: string;
}

export type RoutingStrategy = (task: string, agents: AgentRegistryEntry[]) => string | string[];

export type SynthesisStrategy = (results: SupervisorTaskResult[]) => string | Promise<string>;

// ---------------------------------------------------------------------------
// Supervisor event classes
// ---------------------------------------------------------------------------

export class TaskRoutedEvent extends Event {
  static readonly type = 'task.routed' as const;
  readonly task: string;
  readonly agentNames: string[];
  constructor(task: string, agentNames: string[]) {
    super(TaskRoutedEvent.type);
    this.task = task;
    this.agentNames = agentNames;
  }
}

export class TaskCompletedEvent extends Event {
  static readonly type = 'task.completed' as const;
  readonly task: string;
  readonly agentName: string;
  readonly result: RunResult;
  constructor(task: string, agentName: string, result: RunResult) {
    super(TaskCompletedEvent.type);
    this.task = task;
    this.agentName = agentName;
    this.result = result;
  }
}

export class TaskFailedEvent extends Event {
  static readonly type = 'task.failed' as const;
  readonly task: string;
  readonly agentName: string;
  readonly error: unknown;
  constructor(task: string, agentName: string, error: unknown) {
    super(TaskFailedEvent.type);
    this.task = task;
    this.agentName = agentName;
    this.error = error;
  }
}

export class SynthesisStartedEvent extends Event {
  static readonly type = 'synthesis.started' as const;
  readonly task: string;
  readonly results: SupervisorTaskResult[];
  constructor(task: string, results: SupervisorTaskResult[]) {
    super(SynthesisStartedEvent.type);
    this.task = task;
    this.results = results;
  }
}

export class SynthesisCompletedEvent extends Event {
  static readonly type = 'synthesis.completed' as const;
  readonly task: string;
  readonly synthesis: string;
  constructor(task: string, synthesis: string) {
    super(SynthesisCompletedEvent.type);
    this.task = task;
    this.synthesis = synthesis;
  }
}

export interface SupervisorEventMap extends EventMap {
  [TaskRoutedEvent.type]: TaskRoutedEvent;
  [TaskCompletedEvent.type]: TaskCompletedEvent;
  [TaskFailedEvent.type]: TaskFailedEvent;
  [SynthesisStartedEvent.type]: SynthesisStartedEvent;
  [SynthesisCompletedEvent.type]: SynthesisCompletedEvent;
}

export type SupervisorEvents = SupervisorEventMap;

export type SupervisorEventType = keyof SupervisorEventMap;

export interface CreateSupervisorOptions {
  agents: AgentRegistryEntry[] | AgentRegistry;
  routing: RoutingStrategy;
  synthesis?: SynthesisStrategy;
  maximumDelegations?: number;
  signal?: AbortSignal;
}

export interface PipelineStage {
  agentName: string;
  mapInput?: (previousOutput: string, originalTask: string) => string;
}

export interface Supervisor {
  delegate(task: string): Promise<SupervisorResult>;
  delegateAll(tasks: string[], options?: { parallel?: boolean }): Promise<SupervisorResult[]>;
  pipeline(task: string, stages: PipelineStage[]): Promise<SupervisorResult>;
  addEventListener: <K extends SupervisorEventType>(
    type: K,
    listener: (event: SupervisorEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <K extends SupervisorEventType>(
    type: K,
    listener: (event: SupervisorEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  on: <K extends SupervisorEventType>(type: K) => ObservableLike<SupervisorEventMap[K]>;
  once: <K extends SupervisorEventType>(
    type: K,
    listener: (event: SupervisorEventMap[K]) => void,
  ) => void;
  subscribe: <K extends SupervisorEventType>(
    type: K,
    observerOrNext?: Observer<SupervisorEventMap[K]> | ((value: SupervisorEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<SupervisorEventMap[SupervisorEventType]>;
}

function defaultSynthesis(results: SupervisorTaskResult[]): string {
  return results
    .map((r) => {
      const attribution = `[${r.agentName}]`;
      if (r.error) {
        const errorMessage = r.error instanceof Error ? r.error.message : 'Unknown error';
        return `${attribution} Error: ${errorMessage}`;
      }
      return `${attribution} ${r.result?.content ?? ''}`;
    })
    .join('\n\n');
}

function resolveAgentPool(agents: AgentRegistryEntry[] | AgentRegistry): AgentRegistryEntry[] {
  if (Array.isArray(agents)) {
    return agents;
  }
  return agents.entries();
}

export function createSupervisor(options: CreateSupervisorOptions): Supervisor {
  const {
    agents: agentSource,
    routing,
    synthesis = defaultSynthesis,
    maximumDelegations = 10,
    signal,
  } = options;

  const events = new CompletableEventTarget<SupervisorEventMap>();
  let delegationCount = 0;

  async function runAgent(
    task: string,
    agentName: string,
    pool: AgentRegistryEntry[],
  ): Promise<SupervisorTaskResult> {
    const entry = pool.find((e) => e.agent.name === agentName);
    if (!entry) {
      const error = new Error(`Agent "${agentName}" not found in pool`);
      events.dispatch(new TaskFailedEvent(task, agentName, error));
      return { task, agentName, error };
    }

    try {
      const runResult = await entry.agent.run(task, { signal: signal ?? undefined });
      const result = runResult as import('./types').RunResult;
      events.dispatch(new TaskCompletedEvent(task, agentName, result));
      return { task, agentName, result };
    } catch (error) {
      events.dispatch(new TaskFailedEvent(task, agentName, error));
      return { task, agentName, error };
    }
  }

  async function delegateOne(task: string): Promise<SupervisorResult> {
    if (delegationCount >= maximumDelegations) {
      throw new Error(`Maximum delegations (${maximumDelegations}) exceeded`);
    }

    signal?.throwIfAborted();

    const pool = resolveAgentPool(agentSource);
    const routingResult = routing(task, pool);
    const agentNames = Array.isArray(routingResult) ? routingResult : [routingResult];

    delegationCount += agentNames.length;

    if (delegationCount > maximumDelegations) {
      throw new Error(`Maximum delegations (${maximumDelegations}) exceeded`);
    }

    events.dispatch(new TaskRoutedEvent(task, agentNames));

    let agentResults: SupervisorTaskResult[];

    if (agentNames.length === 1) {
      const result = await runAgent(task, agentNames[0]!, pool);
      agentResults = [result];
    } else {
      agentResults = await Promise.all(agentNames.map((name) => runAgent(task, name, pool)));
    }

    events.dispatch(new SynthesisStartedEvent(task, agentResults));
    const synthesisResult = await synthesis(agentResults);
    events.dispatch(new SynthesisCompletedEvent(task, synthesisResult));

    return { task, agentResults, synthesis: synthesisResult };
  }

  return {
    delegate: delegateOne,

    async delegateAll(
      tasks: string[],
      options?: { parallel?: boolean },
    ): Promise<SupervisorResult[]> {
      if (options?.parallel) {
        return Promise.all(tasks.map((task) => delegateOne(task)));
      }
      const results: SupervisorResult[] = [];
      for (const task of tasks) {
        results.push(await delegateOne(task));
      }
      return results;
    },

    async pipeline(task: string, stages: PipelineStage[]): Promise<SupervisorResult> {
      if (stages.length === 0) {
        return { task, agentResults: [], synthesis: '' };
      }

      const pool = resolveAgentPool(agentSource);
      const allStageResults: SupervisorTaskResult[] = [];
      let previousOutput = '';

      for (const stage of stages) {
        signal?.throwIfAborted();

        const stageInput = stage.mapInput
          ? stage.mapInput(previousOutput, task)
          : previousOutput || task;

        events.dispatch(new TaskRoutedEvent(stageInput, [stage.agentName]));

        const stageResult = await runAgent(stageInput, stage.agentName, pool);
        allStageResults.push(stageResult);

        if (stageResult.error) {
          events.dispatch(new SynthesisStartedEvent(task, allStageResults));
          const synthesisResult = await synthesis(allStageResults);
          events.dispatch(new SynthesisCompletedEvent(task, synthesisResult));
          return { task, agentResults: allStageResults, synthesis: synthesisResult };
        }

        previousOutput = stageResult.result?.content ?? '';
      }

      events.dispatch(new SynthesisStartedEvent(task, allStageResults));
      const finalContent = previousOutput;
      events.dispatch(new SynthesisCompletedEvent(task, finalContent));

      return { task, agentResults: allStageResults, synthesis: finalContent };
    },

    addEventListener: events.addEventListener.bind(events) as Supervisor['addEventListener'],
    removeEventListener: events.removeEventListener.bind(
      events,
    ) as Supervisor['removeEventListener'],
    on: events.on.bind(events) as Supervisor['on'],
    once: events.once.bind(events) as Supervisor['once'],
    subscribe: events.subscribe.bind(events) as Supervisor['subscribe'],
    toObservable: events.toObservable.bind(events) as Supervisor['toObservable'],
  };
}

// Built-in routing helpers

export function createRoundRobinRouting(): RoutingStrategy {
  let index = 0;
  return (_task: string, agents: AgentRegistryEntry[]): string => {
    if (agents.length === 0) throw new Error('No agents available for routing');
    const agent = agents[index % agents.length]!;
    index++;
    return agent.agent.name;
  };
}

export function createCapabilityRouting(
  capabilityExtractor?: (task: string) => string[],
): RoutingStrategy {
  const extractor = capabilityExtractor ?? defaultCapabilityExtractor;
  return (task: string, agents: AgentRegistryEntry[]): string => {
    const requestedCapabilities = extractor(task);
    let bestMatch: AgentRegistryEntry | undefined;
    let bestScore = -1;

    for (const entry of agents) {
      const entryCaps = entry.capabilities.map((c) => c.toLowerCase());
      const score = requestedCapabilities.filter((cap) =>
        entryCaps.includes(cap.toLowerCase()),
      ).length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (!bestMatch) throw new Error('No agents available for routing');
    return bestMatch.agent.name;
  };
}

function defaultCapabilityExtractor(task: string): string[] {
  return task.toLowerCase().split(/\s+/);
}

export function createFanOutRouting(): RoutingStrategy {
  return (_task: string, agents: AgentRegistryEntry[]): string[] => {
    return agents.map((entry) => entry.agent.name);
  };
}
