import { createTestToolbox } from 'armorer/test';
import type { EmissionEvent } from 'event-emission';

import {
  type AgentRegistry,
  type AgentRegistryEntry,
  createAgentRegistry,
} from '../create-agent-registry';
import type { ActiveRun } from '../create-run';
import { createScratchpad, type Scratchpad } from '../create-scratchpad';
import type {
  CombinedOperativeEvents,
  CombinedOperativeEventType,
  OperativeEvents,
  OperativeEventType,
} from '../events';
import type { AgentDefinition, GenerateFunction, GenerateResponse, StepResult } from '../types';

/**
 * Creates a mock generate function that returns responses in sequence.
 */
export function createMockGenerate(
  responses: GenerateResponse[],
): GenerateFunction & { calls: Parameters<GenerateFunction>[]; callCount: number } {
  const calls: Parameters<GenerateFunction>[] = [];
  let index = 0;

  const fn = async (...args: Parameters<GenerateFunction>): Promise<GenerateResponse> => {
    calls.push(args);
    const response = responses[index];
    if (!response) {
      throw new Error(
        `createMockGenerate: no response at index ${index} (${responses.length} total)`,
      );
    }
    index++;
    return response;
  };

  Object.defineProperty(fn, 'calls', { get: () => calls });
  Object.defineProperty(fn, 'callCount', { get: () => calls.length });

  return fn as GenerateFunction & {
    calls: Parameters<GenerateFunction>[];
    callCount: number;
  };
}

/**
 * Creates a mock generate function that returns a single response once,
 * then throws on subsequent calls.
 */
export function createMockGenerateOnce(response: GenerateResponse): GenerateFunction {
  let called = false;
  return async () => {
    if (called) {
      throw new Error('createMockGenerateOnce: already called');
    }
    called = true;
    return response;
  };
}

/**
 * Records all events from an ActiveRun for test assertions.
 */
export interface RunRecorder {
  events: Array<{
    type: CombinedOperativeEventType;
    detail: CombinedOperativeEvents[CombinedOperativeEventType];
  }>;
  steps: StepResult[];
  clear: () => void;
}

export function createMockScratchpad(initialValues?: Record<string, unknown>): Scratchpad {
  return createScratchpad({ initialValues });
}

export function createMockAgentDefinition(
  name: string,
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name,
    options: {
      name,
      generate: async () => ({ content: `Mock response from ${name}`, toolCalls: [] }),
      toolbox: createTestToolbox([]),
    },
    run: async () => ({
      conversation: {} as never,
      steps: [],
      content: `Mock response from ${name}`,
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'stop-condition' as const,
    }),
    createRun: () => ({}) as never,
    ...overrides,
  };
}

export function createMockAgentRegistry(entries?: AgentRegistryEntry[]): AgentRegistry {
  const registry = createAgentRegistry();
  if (entries) {
    for (const entry of entries) {
      registry.register(entry);
    }
  }
  return registry;
}

export function createRunRecorder(activeRun: ActiveRun): RunRecorder {
  const events: RunRecorder['events'] = [];
  const steps: StepResult[] = [];

  const eventTypes: OperativeEventType[] = [
    'run.started',
    'step.started',
    'step.generated',
    'tools.executing',
    'tools.executed',
    'step.completed',
    'run.completed',
    'run.error',
    'run.aborted',
    'step.aborted',
    'generate.started',
    'generate.completed',
    'generate.error',
    'generate.retry',
    'response.validated',
    'tool-result.validated',
    'context.compacted',
    'response.schema-failed',
    'elicitation.requested',
    'elicitation.resolved',
    'backpressure.applied',
    'backpressure.released',
    'usage.accumulated',
    'session.saved',
    'session.loaded',
  ];

  for (const type of eventTypes) {
    activeRun.addEventListener(
      type,
      (event: EmissionEvent<OperativeEvents[typeof type], typeof type>) => {
        events.push({ type, detail: event.detail });
        if (type === 'step.completed') {
          steps.push(event.detail as StepResult);
        }
      },
    );
  }

  return {
    events,
    steps,
    clear() {
      events.length = 0;
      steps.length = 0;
    },
  };
}
