import type { ActiveRun } from '../create-run';
import { createScratchpad, type Scratchpad } from '../create-scratchpad';
import type { OperativeEventMap, OperativeEventType } from '../events';
import type { GenerateFunction, GenerateResponse, StepResult } from '../types';

export {
  createManualCheckpointStore,
  createManualDurableEngine,
  type EngineSpy,
  spyEngine,
} from './durable-engine';
export type {
  ChildRunHandle,
  CreateDurableMultiAgentHarnessOptions,
  DurableMultiAgentHarness,
} from './durable-multi-agent-harness';
export { createDurableMultiAgentHarness } from './durable-multi-agent-harness';
export type { PromptInjectionFixtureCase } from './prompt-injection-fixtures';
export { PROMPT_INJECTION_FIXTURES } from './prompt-injection-fixtures';
export { createStepwiseBlockingGenerate } from './stepwise-generate';
export { createTestStore } from './store';
export { type RunLookup, waitForCondition, waitForRunState } from './wait';
// AB-92/AB-252 — the deterministic `RuntimeServices` implementation lives in
// `lifecycle` (a private foundation package, inlined at build time) and is
// re-exported here so `@lostgradient/operative/test` stays the import path
// a test author uses — a caller composes `runtime: createManualRuntimeServices()`
// onto `createAgent`/`createActiveRun` instead of touching a real timer or
// a real clock.
export type { ManualRuntimeServices } from 'lifecycle';
export { createManualRuntimeServices } from 'lifecycle';

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
 *
 * After migration to EventTarget, events are Event subclasses with
 * named properties (not EmissionEvent with .detail). The recorder
 * captures them as `{ type, detail }` where `detail` is the event
 * itself — so tests that accessed `event.detail.foo` now access
 * `event.foo` on the event object directly.
 */
export interface RunRecorder {
  events: Array<{
    type: OperativeEventType;
    detail: OperativeEventMap[OperativeEventType];
  }>;
  steps: StepResult[];
  clear: () => void;
}

export function createMockScratchpad(initialValues?: Record<string, unknown>): Scratchpad {
  return createScratchpad({ initialValues });
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
    'run.tripwire',
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
    'context.budget-warning',
    // Steering (AB-90 child ab90-01 / AB-221): only `steering.applied` is
    // dispatched by this package today (from `runStep`'s AB-67/AB-198
    // boundary); the other four are exported for AB-199's admission path to
    // dispatch through the same ActiveRun surface once it exists. Listed
    // here now so a consumer test using this recorder can assert on any of
    // them without another silent gap.
    'steering.accepted',
    'steering.applied',
    'steering.rejected',
    'steering.superseded',
    'steering.failed',
  ];

  for (const type of eventTypes) {
    activeRun.addEventListener(type, (event: Event) => {
      events.push({ type, detail: event });
      if (type === 'step.completed') {
        steps.push(event as unknown as StepResult);
      }
    });
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
