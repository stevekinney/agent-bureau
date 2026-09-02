/**
 * The typed multi-agent supervisor (AB-22) — moved here from operative,
 * rebuilt against `BureauAgentCatalog<D>` instead of the deleted
 * `AgentRegistry`. Delegates a task to one or more catalog agents, chosen by
 * a pluggable `RoutingStrategy<D>`, and synthesizes their results.
 */

import type { AgentRunContext, RunResult } from '@lostgradient/operative';
import type { EventMap, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget } from 'lifecycle';

import type { AgentDefinitions, AgentNames, BureauAgentCatalog } from './agent-catalog';

/**
 * Metadata-only view of a catalog entry handed to a `RoutingStrategy` — just
 * the name. `RunnableAgent` carries no description/capabilities/tags to
 * route on (those died with `AgentRegistry`), and reading a lazy agent's own
 * `.name` would give the `'(lazy)'` placeholder rather than its catalog key,
 * so descriptors are built from catalog keys, never from the agent objects
 * themselves — this is also why routing never has to load a lazy agent to
 * decide whether to select it.
 */
export interface AgentDescriptor<D extends AgentDefinitions = AgentDefinitions> {
  readonly name: AgentNames<D>;
}

/**
 * Chooses one or more agents for a task from the catalog's descriptors.
 * `Promise<...>` is a real branch, not the whole return type, because
 * `createRoundRobinRouting`/`createFanOutRouting` resolve synchronously; a
 * caller-supplied strategy may await external state (a policy lookup, an
 * LLM-based router) before deciding.
 */
export type RoutingStrategy<D extends AgentDefinitions> = (
  task: string,
  descriptors: readonly AgentDescriptor<D>[],
) => AgentNames<D> | readonly AgentNames<D>[] | Promise<AgentNames<D> | readonly AgentNames<D>[]>;

export type SynthesisStrategy = (results: SupervisorTaskResult[]) => string | Promise<string>;

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

export interface PipelineStage<D extends AgentDefinitions> {
  agentName: AgentNames<D>;
  mapInput?: (previousOutput: string, originalTask: string) => string;
}

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

export interface CreateSupervisorOptions<D extends AgentDefinitions> {
  agents: BureauAgentCatalog<D>;
  routing: RoutingStrategy<D>;
  synthesis?: SynthesisStrategy;
  maximumDelegations?: number;
  signal?: AbortSignal;
}

export interface Supervisor<D extends AgentDefinitions = AgentDefinitions> {
  delegate(task: string): Promise<SupervisorResult>;
  delegateAll(tasks: string[], options?: { parallel?: boolean }): Promise<SupervisorResult[]>;
  pipeline(task: string, stages: PipelineStage<D>[]): Promise<SupervisorResult>;
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

/**
 * Creates the metadata-only descriptor list `RoutingStrategy` selects from —
 * catalog keys only, in definition order, never touching `.agent`.
 */
function describeAgents<D extends AgentDefinitions>(
  catalog: BureauAgentCatalog<D>,
): AgentDescriptor<D>[] {
  return catalog.names().map((name) => ({ name }));
}

export function createSupervisor<D extends AgentDefinitions>(
  options: CreateSupervisorOptions<D>,
): Supervisor<D> {
  const {
    agents: catalog,
    routing,
    synthesis = defaultSynthesis,
    maximumDelegations = 10,
    signal,
  } = options;

  const events = new CompletableEventTarget<SupervisorEventMap>();
  let delegationCount = 0;

  // `catalog.get()` throws its own "Unknown agent" error for a name absent
  // from the catalog — the try/catch below folds that into the same
  // TaskFailedEvent/SupervisorTaskResult.error path as any other run
  // failure, so `pipeline()`'s direct `runAgent` call (which does not go
  // through `resolveRoutedNames`'s validation) still reports an unknown
  // stage `agentName` as a failed stage rather than throwing out of
  // `pipeline()` itself.
  async function runAgent(task: string, agentName: AgentNames<D>): Promise<SupervisorTaskResult> {
    try {
      const context: AgentRunContext = { agentName, ...(signal ? { signal } : {}) };
      const run = catalog.get(agentName).run(task, context);
      const runResult = (await run.result()) as RunResult;
      if (isFailureResult(runResult)) {
        const error =
          runResult.error instanceof Error
            ? runResult.error
            : new Error(`Agent "${agentName}" finished with reason "${runResult.finishReason}"`);
        events.dispatch(new TaskFailedEvent(task, agentName, error));
        // Keep `result` so callers can still inspect partial content/usage.
        return { task, agentName, result: runResult, error };
      }
      events.dispatch(new TaskCompletedEvent(task, agentName, runResult));
      return { task, agentName, result: runResult };
    } catch (error) {
      events.dispatch(new TaskFailedEvent(task, agentName, error));
      return { task, agentName, error };
    }
  }

  /** Validates every routed name against the catalog before retrieving any agent. */
  async function resolveRoutedNames(task: string): Promise<AgentNames<D>[]> {
    const routingResult = await routing(task, describeAgents(catalog));
    const names: readonly AgentNames<D>[] = Array.isArray(routingResult)
      ? routingResult
      : [routingResult];
    for (const name of names) {
      const nameAsString: string = name;
      if (!catalog.has(nameAsString)) {
        // `catalog.has`'s type predicate narrows the negative branch to
        // `Exclude<string, AgentNames<D>>`, which TypeScript collapses to
        // `never` for a generic `D` — `String(...)` re-widens it to `string`
        // so the template literal reports the actual runtime value.
        throw new Error(`Routing strategy selected unknown agent "${String(nameAsString)}"`);
      }
    }
    return [...names];
  }

  async function delegateOne(task: string): Promise<SupervisorResult> {
    if (delegationCount >= maximumDelegations) {
      throw new Error(`Maximum delegations (${maximumDelegations}) exceeded`);
    }

    signal?.throwIfAborted();

    const agentNames = await resolveRoutedNames(task);

    // Recheck after the (possibly asynchronous) routing strategy resolves —
    // a caller-supplied `RoutingStrategy` may itself await external state (a
    // policy lookup, an LLM-based router), so the check above can be stale
    // by the time routing actually decides. Without this second check, an
    // abort requested during that window would still increment the
    // delegation count, dispatch `task.routed`, and invoke every selected
    // agent — even one that does not independently honor `signal` — instead
    // of rejecting the delegation before any of that starts.
    signal?.throwIfAborted();

    delegationCount += agentNames.length;

    if (delegationCount > maximumDelegations) {
      throw new Error(`Maximum delegations (${maximumDelegations}) exceeded`);
    }

    events.dispatch(new TaskRoutedEvent(task, agentNames));

    let agentResults: SupervisorTaskResult[];

    if (agentNames.length === 1) {
      const result = await runAgent(task, agentNames[0]!);
      agentResults = [result];
    } else {
      agentResults = await Promise.all(agentNames.map((name) => runAgent(task, name)));
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
      delegateOptions?: { parallel?: boolean },
    ): Promise<SupervisorResult[]> {
      if (delegateOptions?.parallel) {
        return Promise.all(tasks.map((task) => delegateOne(task)));
      }
      const results: SupervisorResult[] = [];
      for (const task of tasks) {
        results.push(await delegateOne(task));
      }
      return results;
    },

    async pipeline(task: string, stages: PipelineStage<D>[]): Promise<SupervisorResult> {
      if (stages.length === 0) {
        return { task, agentResults: [], synthesis: '' };
      }

      const allStageResults: SupervisorTaskResult[] = [];
      let previousOutput = '';

      for (const stage of stages) {
        signal?.throwIfAborted();

        const stageInput = stage.mapInput
          ? stage.mapInput(previousOutput, task)
          : previousOutput || task;

        events.dispatch(new TaskRoutedEvent(stageInput, [stage.agentName]));

        const stageResult = await runAgent(stageInput, stage.agentName);
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

    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    on: events.on.bind(events) as Supervisor<D>['on'],
    once: events.once.bind(events) as Supervisor<D>['once'],
    subscribe: events.subscribe.bind(events) as Supervisor<D>['subscribe'],
    toObservable: events.toObservable.bind(events),
  };
}

/** The subset of `FinishReason` values that indicate an unsuccessful run. */
const FAILURE_FINISH_REASONS: ReadonlySet<RunResult['finishReason']> = new Set([
  'error',
  'aborted',
  'budget-exceeded',
  'elicitation-denied',
  'tripwire',
]);

function isFailureResult(result: RunResult): boolean {
  return FAILURE_FINISH_REASONS.has(result.finishReason);
}

// ---------------------------------------------------------------------------
// Built-in routing strategies — generic over D, working from descriptors
// (catalog keys) only. `createCapabilityRouting` from the predecessor
// registry-based API is NOT ported: it scored `entry.capabilities`, data
// that no longer exists anywhere (`RunnableAgent` carries none, and
// `AgentDescriptor` is deliberately metadata-only per AB-22). A caller that
// needs capability-based routing supplies its own `RoutingStrategy<D>`,
// closing over whatever side table maps agent names to capabilities.
// ---------------------------------------------------------------------------

export function createRoundRobinRouting<D extends AgentDefinitions>(): RoutingStrategy<D> {
  let index = 0;
  return (_task, descriptors) => {
    if (descriptors.length === 0) throw new Error('No agents available for routing');
    const descriptor = descriptors[index % descriptors.length]!;
    index++;
    return descriptor.name;
  };
}

export function createFanOutRouting<D extends AgentDefinitions>(): RoutingStrategy<D> {
  return (_task, descriptors) => descriptors.map((descriptor) => descriptor.name);
}
