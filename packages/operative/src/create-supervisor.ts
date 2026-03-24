import type { AddEventListenerOptionsLike, EmissionEvent } from 'event-emission';
import { createEventTarget } from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';

import { bindEmitter } from './bind-emitter';
import type { AgentRegistry, AgentRegistryEntry } from './create-agent-registry';
import type { Scratchpad } from './create-scratchpad';
import { createScratchpadReadTool, createScratchpadWriteTool } from './create-scratchpad';
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

export interface SupervisorEvents {
  'task.routed': { task: string; agentNames: string[] };
  'task.completed': { task: string; agentName: string; result: RunResult };
  'task.failed': { task: string; agentName: string; error: unknown };
  'synthesis.started': { task: string; results: SupervisorTaskResult[] };
  'synthesis.completed': { task: string; synthesis: string };
}

export type SupervisorEventType = keyof SupervisorEvents;

export interface CreateSupervisorOptions {
  agents: AgentRegistryEntry[] | AgentRegistry;
  routing: RoutingStrategy;
  synthesis?: SynthesisStrategy;
  scratchpad?: Scratchpad;
  maximumDelegations?: number;
  signal?: AbortSignal;
}

export interface PipelineStage {
  agentName: string;
  mapInput?: (previousOutput: string, originalTask: string) => string;
}

export interface Supervisor {
  delegate(task: string): Promise<SupervisorResult>;
  delegateAll(tasks: string[]): Promise<SupervisorResult[]>;
  pipeline(task: string, stages: PipelineStage[]): Promise<SupervisorResult>;
  addEventListener: <K extends SupervisorEventType>(
    type: K,
    listener: (event: EmissionEvent<SupervisorEvents[K], K>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ) => () => void;
  on: <K extends SupervisorEventType>(
    type: K,
    listener: (event: EmissionEvent<SupervisorEvents[K], K>) => void | Promise<void>,
  ) => () => void;
  once: <K extends SupervisorEventType>(
    type: K,
    listener: (event: EmissionEvent<SupervisorEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ) => () => void;
  subscribe: <K extends SupervisorEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<SupervisorEvents[K], K>>
      | ((value: EmissionEvent<SupervisorEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<
    EmissionEvent<SupervisorEvents[SupervisorEventType], SupervisorEventType>
  >;
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
    scratchpad,
    maximumDelegations = 10,
    signal,
  } = options;

  const events = createEventTarget<SupervisorEvents>();
  let delegationCount = 0;

  async function runAgent(
    task: string,
    agentName: string,
    pool: AgentRegistryEntry[],
  ): Promise<SupervisorTaskResult> {
    const entry = pool.find((e) => e.agent.name === agentName);
    if (!entry) {
      const error = new Error(`Agent "${agentName}" not found in pool`);
      events.emit('task.failed', { task, agentName, error });
      return { task, agentName, error };
    }

    try {
      const agentRunOptions: { conversation: string; signal?: AbortSignal } = {
        conversation: task,
        ...(signal && { signal }),
      };

      // If scratchpad is provided, extend the agent's toolbox with scratchpad tools
      if (scratchpad) {
        const readTool = createScratchpadReadTool(scratchpad);
        const writeTool = createScratchpadWriteTool(scratchpad);
        const extendedToolbox = entry.agent.options.toolbox.extend(readTool, writeTool);
        const { Conversation } = await import('conversationalist');
        const conversation = new Conversation();
        if (entry.agent.options.instructions) {
          const instructions =
            typeof entry.agent.options.instructions === 'string'
              ? entry.agent.options.instructions
              : (entry.agent.options.instructions as { render(): string }).render();
          conversation.appendSystemMessage(instructions);
        }
        conversation.appendUserMessage(task);
        const { run } = await import('./run');
        const {
          name: _,
          instructions: __,
          stopWhen: definitionStopWhen,
          ...rest
        } = entry.agent.options;
        const result = await run({
          ...rest,
          toolbox: extendedToolbox,
          conversation,
          signal,
          stopWhen: definitionStopWhen,
        });
        events.emit('task.completed', { task, agentName, result });
        return { task, agentName, result };
      }

      const result = await entry.agent.run(agentRunOptions);
      events.emit('task.completed', { task, agentName, result });
      return { task, agentName, result };
    } catch (error) {
      events.emit('task.failed', { task, agentName, error });
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

    events.emit('task.routed', { task, agentNames });

    let agentResults: SupervisorTaskResult[];

    if (agentNames.length === 1) {
      const result = await runAgent(task, agentNames[0]!, pool);
      agentResults = [result];
    } else {
      agentResults = await Promise.all(agentNames.map((name) => runAgent(task, name, pool)));
    }

    events.emit('synthesis.started', { task, results: agentResults });
    const synthesisResult = await synthesis(agentResults);
    events.emit('synthesis.completed', { task, synthesis: synthesisResult });

    return { task, agentResults, synthesis: synthesisResult };
  }

  return {
    delegate: delegateOne,

    async delegateAll(tasks: string[]): Promise<SupervisorResult[]> {
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

        events.emit('task.routed', { task: stageInput, agentNames: [stage.agentName] });

        const stageResult = await runAgent(stageInput, stage.agentName, pool);
        allStageResults.push(stageResult);

        if (stageResult.error) {
          events.emit('synthesis.started', { task, results: allStageResults });
          const synthesisResult = await synthesis(allStageResults);
          events.emit('synthesis.completed', { task, synthesis: synthesisResult });
          return { task, agentResults: allStageResults, synthesis: synthesisResult };
        }

        previousOutput = stageResult.result?.content ?? '';
      }

      events.emit('synthesis.started', { task, results: allStageResults });
      const finalContent = previousOutput;
      events.emit('synthesis.completed', { task, synthesis: finalContent });

      return { task, agentResults: allStageResults, synthesis: finalContent };
    },

    ...bindEmitter<SupervisorEvents>(events),
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
