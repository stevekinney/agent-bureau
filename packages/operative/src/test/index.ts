import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import type { ActiveRun } from '../create-run';
import { createScratchpad, type Scratchpad } from '../create-scratchpad';
import type {
  CombinedOperativeEventClassMap,
  CombinedOperativeEventMap,
  CombinedOperativeEventType,
} from '../events';
import { COMBINED_OPERATIVE_EVENT_TYPES } from '../events';
import type { GenerateFunction, GenerateResponse, StepResult } from '../types';
import { createEventRecorder } from './event-recorder';

export {
  assembleBaselineArtifact,
  InvalidReproductionArtifactError,
  readReproductionArtifact,
  replayReproductionArtifact,
  ReproductionArtifactMismatchError,
  runBaselineReplayCase,
  writeReproductionArtifact,
} from './artifact-io';
export type {
  BaselineReplayResult,
  ReproductionArtifact,
  ReproductionCleanupReport,
  ScriptedOutcome,
} from './artifact-io';
export { createBarrierRegistry } from './barriers';
export type { Barrier, BarrierRegistry, BarrierState } from './barriers';
export {
  createManualCheckpointStore,
  createManualDurableEngine,
  spyEngine,
  type EngineSpy,
} from './durable-engine';
export { createDurableMultiAgentHarness } from './durable-multi-agent-harness';
export type {
  ChildRunHandle,
  CreateDurableMultiAgentHarnessOptions,
  DurableMultiAgentHarness,
} from './durable-multi-agent-harness';
export { createEventRecorder } from './event-recorder';
export type { CausalTraceEntry, EventRecorder, EventRecorderOwnerIdentity } from './event-recorder';
export {
  createFaultEngine,
  FAULT_BOUNDARY_EFFECT_KINDS,
  UnsupportedFaultBoundaryError,
} from './fault-engine';
export type {
  FaultBlockEffect,
  FaultCorruptPayloadEffect,
  FaultDelayEffect,
  FaultDropAcknowledgementEffect,
  FaultDuplicateDeliveryEffect,
  FaultEffect,
  FaultEngine,
  FaultFailAfterCommitEffect,
  FaultFailAfterEffect,
  FaultFailBeforeCommitEffect,
  FaultIgnoreAbortEffect,
  FaultRejectBeforeWorkEffect,
  FaultStaleReadEffect,
} from './fault-engine';
export type {
  FaultBoundary,
  FaultOccurrence,
  FaultOperation,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
} from './fault-plan';
export { PROMPT_INJECTION_FIXTURES } from './prompt-injection-fixtures';
export type { PromptInjectionFixtureCase } from './prompt-injection-fixtures';
export { runReactiveSourceConformanceSuite } from './reactive-source-suite';
export type {
  ReactiveSourceConformanceOptions,
  ReactiveSourceConformanceTestRunner,
  ReactiveSourceSubject,
} from './reactive-source-suite';
export { createResourceScope, QuiescenceError } from './resource-scope';
export type {
  ClosableRun,
  DetachedResource,
  LeakedResource,
  LeakedResourceDiscoveredVia,
  LeakedResourceKind,
  QuiescenceReport,
  RegisterableResource,
  ResourceScope,
} from './resource-scope';
export {
  DuplicatePartyNameError,
  InvalidMaximumSchedulesError,
  InvalidPartyCountError,
  runBoundedSchedules,
  UnsupportedScenarioError,
} from './schedule-runner';
export type { BoundedScheduleOptions, BoundedScheduleReport, Schedule } from './schedule-runner';
export { createScriptedGenerate } from './scripted-generate';
export type {
  ScriptedGenerate,
  ScriptedGenerateCall,
  ScriptedGenerateExpectation,
  ScriptedGenerateStep,
} from './scripted-generate';
export { createScriptedHook, createScriptedTool } from './scripted-tool';
export type {
  ScriptedHook,
  ScriptedHookCall,
  ScriptedHookPhase,
  ScriptedHookStep,
  ScriptedSettlement,
  ScriptedTool,
  ScriptedToolCall,
  ScriptedToolStep,
} from './scripted-tool';
export { createStepwiseBlockingGenerate } from './stepwise-generate';
export { createTestStore } from './store';
export { waitForCondition, waitForRunState, type RunLookup } from './wait';
// Deterministic runtime services are owned by @lostgradient/lifecycle and exposed
// with these test fixtures through the package root.
export { createManualRuntimeServices } from '@lostgradient/lifecycle';
export type { ManualRuntimeServices } from '@lostgradient/lifecycle';

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
    type: CombinedOperativeEventType;
    detail: CombinedOperativeEventMap[CombinedOperativeEventType];
  }>;
  steps: StepResult[];
  clear: () => void;
}

export function createMockScratchpad(initialValues?: Record<string, unknown>): Scratchpad {
  return createScratchpad({ initialValues });
}

/**
 * Reimplemented on top of `createEventRecorder` (AB-255): the deleted
 * hand-maintained 32-entry `eventTypes` array is replaced by
 * `COMBINED_OPERATIVE_EVENT_TYPES`, the runtime-visible complete list
 * `events.ts`'s exhaustiveness check keeps honest. `EventRecorder.attach`
 * does the actual subscription (proving `createRunRecorder` is genuinely
 * built on it, not merely importing the constant it exports); `events`/
 * `steps` are captured through a second, independent listener registration
 * over that same shared constant, kept in lockstep with `attach`'s
 * subscription by construction (one array, not two hand-maintained lists)
 * rather than by sharing storage — `EventRecorder.normalize()`'s portable,
 * byte-identical-across-machines projection deliberately collapses a class
 * instance (e.g. `Conversation`) to `{ $kind: 'Conversation' }`, which would
 * break existing consumers that assert `.detail.conversation instanceof
 * Conversation`. `RunRecorder`'s `.detail` stays the raw dispatched event,
 * exactly as before this slice.
 */
export function createRunRecorder(
  activeRun: ActiveRun,
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): RunRecorder {
  const events: RunRecorder['events'] = [];
  const steps: StepResult[] = [];

  const recorder = createEventRecorder(runtime);
  recorder.attach<CombinedOperativeEventClassMap>(activeRun, {
    kind: 'run-recorder',
    id: 'legacy-run-recorder',
  });

  for (const type of COMBINED_OPERATIVE_EVENT_TYPES) {
    activeRun.addEventListener(type, (event) => {
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
