import {
  LIVENESS_POLICY_VERSION,
  type ActiveRun,
  type RunState,
  type StepResult,
} from '@lostgradient/operative';
import type { ToolCall } from 'armorer';
import { Conversation } from 'conversationalist';

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a serialized record');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected serialized records');
  return value.map(requireRecord);
}

export function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a serialized string');
  return value;
}

export function buildStubLivenessSnapshot(): ReturnType<ActiveRun['snapshot']> {
  return {
    id: 'run-5',
    kind: 'agent-run',
    startedAt: new Date(0).toISOString(),
    revision: 0,
    status: 'running',
    lastTransitionAt: new Date(0).toISOString(),
    projection: 'redacted',
    ownership: 'independent',
    detached: false,
    durability: 'process-local',
    cancellable: true,
    attempt: 0,
    reachability: 'unknown',
    progress: 'unknown',
    assessment: 'healthy',
    observedAt: 0,
    missedPulseCount: 0,
    policyVersion: LIVENESS_POLICY_VERSION,
    evidence: [],
  };
}

function unexpectedRunCapability(): never {
  throw new Error('Serialization unexpectedly invoked a live run capability');
}

export function stubActiveRunWithSnapshot(
  snapshot: ReturnType<ActiveRun['snapshot']> = buildStubLivenessSnapshot(),
): ActiveRun {
  return {
    result: new Promise<never>(() => {}),
    abort: unexpectedRunCapability,
    // COR-1270: a stub with no plan, rather than `unexpectedRunCapability` —
    // inspecting a run that has no hooks is a legitimate call, not a
    // capability this stub is asserting nobody reaches for.
    describeHookPlan: () => undefined,
    addEventListener: unexpectedRunCapability,
    removeEventListener: unexpectedRunCapability,
    on: unexpectedRunCapability,
    once: unexpectedRunCapability,
    subscribe: unexpectedRunCapability,
    events: unexpectedRunCapability,
    toObservable: unexpectedRunCapability,
    complete: unexpectedRunCapability,
    closed: unexpectedRunCapability,
    snapshot: () => snapshot,
    subscribeSnapshot: unexpectedRunCapability,
    [Symbol.dispose]: unexpectedRunCapability,
  };
}

export function makeStep(step: number): StepResult {
  return {
    step,
    conversation: new Conversation(),
    content: '',
    toolCalls: [],
    results: [],
    final: false,
  };
}

/** Deliberately inject the non-JSON value that an untyped tool client can supply. */
export function makeNonJsonToolCall(): ToolCall {
  const call: ToolCall = { id: 'tool-call-1', name: 'inspect', arguments: {} };
  Object.defineProperty(call, 'arguments', {
    value: { createdAt: new Date('2026-03-31T21:15:48.000Z') },
    enumerable: true,
  });
  return call;
}

export function makeRunState(snapshot: ReturnType<ActiveRun['snapshot']>): RunState {
  return {
    id: snapshot.id,
    status: 'running',
    steps: [],
    usage: { prompt: 0, completion: 0, total: 0 },
    snapshots: [],
    actions: [],
    activeRun: stubActiveRunWithSnapshot(snapshot),
    finishReason: undefined,
    error: undefined,
  };
}
