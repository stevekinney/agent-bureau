import type { EmissionEvent } from 'event-emission';

import type { ActiveRun } from '../create-run';
import type { OperativeEvents, OperativeEventType } from '../events';
import type { GenerateFunction, GenerateResponse, StepResult } from '../types';

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
    type: OperativeEventType;
    detail: OperativeEvents[OperativeEventType];
  }>;
  steps: StepResult[];
  clear: () => void;
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
    'generate.retry',
    'response.validated',
    'tool-result.validated',
    'context.compacted',
    'response.schema-failed',
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
