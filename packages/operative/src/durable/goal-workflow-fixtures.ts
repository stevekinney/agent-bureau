/**
 * COR-851 — test support for the durable `goalRun` workflow.
 *
 * {@link createGoalWorld} is a fake host: an in-memory goal record that applies
 * transitions with the same rules as Bureau's `GoalStore` (one transition ahead,
 * `duplicate` for the current transition, `stale` for anything else out of
 * order, a cancellation marker that only lets `canceled` through), a registry of
 * attempt runs with a separate claim set so a start can crash between the two,
 * a scripted validator, and a call log that records the exact order of port
 * calls so a test can pin the workflow's slot sequence.
 *
 * The world survives an engine "crash" the way real storage does. A test
 * crashes engine A with {@link GoalWorld.crashAfter}: the named port call
 * performs its effect and then never returns, so the effect landed but its
 * activity result was never recorded, which is exactly the window a real crash
 * leaves open.
 */

import { MemoryStorage, workflow, yieldToPortableEventLoop } from '@lostgradient/weft';

import {
  canTransitionGoalRun,
  type GoalBudget,
  type GoalRetryableReason,
  type GoalRunStatus,
  type ProjectedValidatorOutcome,
  TERMINAL_STATUS_BY_REASON,
  TERMINAL_STATUSES,
} from '../goal-decision';
import { createRunEngine } from './create-run-engine';
import { createGoalWorkflow, type GoalWorkflowOptions } from './goal-workflow';
import {
  type GoalAttemptTerminalSignal,
  goalAttemptTerminalSignalName,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowAttempt,
  type GoalWorkflowCommit,
  type GoalWorkflowIdentifiers,
  type GoalWorkflowPorts,
  type GoalWorkflowRecord,
  type GoalWorkflowStart,
  type GoalWorkflowStartRequest,
  type GoalWorkflowTransition,
  type GoalWorkflowValidatorRequest,
} from './goal-workflow-ports';
import { isDeadlineElapsed } from './goal-workflow-transitions';

export const GOAL_RUN_ID = 'goal-1';
export const GOAL_WORKFLOW_ID = `goal:${GOAL_RUN_ID}`;

/** Mirrors Bureau's `goalTransitionId`, `goalAttemptId`, `goalAttemptRunId`, and `goalDecisionId`. */
export const identifiers: GoalWorkflowIdentifiers = {
  transitionId: (goalRunId, seq) => `${goalRunId}:t${seq}`,
  attemptId: (goalRunId, attemptIndex) => `${goalRunId}:a${attemptIndex}`,
  attemptRunId: (goalRunId, attemptIndex) => `goal-${goalRunId}-a${attemptIndex}`,
  decisionId: (attemptId) => `${attemptId}:decision`,
};

export function createManualClock(startTime = 1_000_000) {
  let now = startTime;
  return {
    getNow: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
      return now;
    },
  };
}

export type ManualClock = ReturnType<typeof createManualClock>;

const POLL_UNTIL_MAX_ATTEMPTS = 2000;

/** Yields the portable event loop until `predicate` holds. */
export async function pollUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < POLL_UNTIL_MAX_ATTEMPTS; attempt += 1) {
    if (await predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('pollUntil exceeded its attempt bound before the condition held');
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface GoalWorldOptions {
  readonly clock: ManualClock;
  readonly bounds?: GoalBudget | undefined;
  readonly retryOn?: readonly GoalRetryableReason[] | undefined;
  readonly validatorTimeoutMs?: number | undefined;
  /** Runs inside every validator call, so a test can move the clock while a verdict is being produced. */
  readonly onValidate?: (() => void) | undefined;
  /** Runs at the top of every `startAttempt`, so a test can move the clock between the controller's read and the start. */
  readonly onStart?: (() => void) | undefined;
}

export interface CrashPoint {
  /** Resolves once the named port call has performed its effect and parked forever. */
  readonly reached: Promise<void>;
}

interface PendingCrash {
  fired: boolean;
  signalReached: () => void;
}

/** The labels {@link GoalWorld.crashAfter} accepts. `commit:<status>` is the target of the transition. */
export type CrashLabel =
  `commit:${GoalRunStatus}` | 'start:claimed' | 'start:started' | 'validate' | 'abort';

export interface GoalWorld {
  readonly ports: GoalWorkflowPorts;
  /** A copy of the record as stored right now. */
  record(): GoalWorkflowRecord;
  /** Every applied transition, in order. */
  readonly transitions: GoalWorkflowTransition[];
  /** Every port call, in order: `load`, `start:<n>`, `commit:<status>:<result>`, `validate:<n>`, `abort:<n>`. */
  readonly calls: string[];
  readonly claims: Set<string>;
  /** Run ids whose start completed, in order. A run id appears at most once. */
  readonly startedRuns: string[];
  readonly abortedRuns: string[];
  /** The activity's own signal each `startAttempt` call was handed, in order. */
  readonly startSignals: (AbortSignal | undefined)[];
  /** The `validatorTimeoutMs` each validator call received, in order. */
  readonly validatorTimeouts: (number | undefined)[];
  /** The `feedback` each `startAttempt` call received, by attempt index. */
  readonly startFeedback: Map<number, string | undefined>;
  /** Outcomes the validator returns, one per call, in order. Defaults to `pass`. */
  readonly validatorOutcomes: ProjectedValidatorOutcome[];
  /** Sets the operator cancellation marker, as Bureau's control plane does. */
  requestCancellation(): void;
  /** Overwrites fields of the stored record, as a goal that was already in that state would have. */
  patchRecord(patch: Partial<GoalWorkflowRecord>): void;
  /** Makes the next `startAttempt` answer `failed`. */
  failNextStart(detail: string): void;
  /** Runs `action` once, immediately before the next commit whose target is `to` is evaluated. */
  beforeNextCommit(to: GoalRunStatus, action: () => void): void;
  /** Answers every commit with `forced` instead of consulting the record. */
  forceCommit(forced: GoalWorkflowCommit | undefined): void;
  /** Makes `loadGoalState` report this fixed time instead of the manual clock's. */
  freezeNow(nowMs: number): void;
  /** Makes `loadGoalState` answer a missing record. */
  makeRecordMissing(): void;
  /** The port call named `label` performs its effect once, then never returns. */
  crashAfter(label: CrashLabel): CrashPoint;
  /**
   * The next `startAttempt` that creates a run parks right after creating it, and
   * answers only once `release` is called: a start that is still in flight when
   * the clock moves, but that does settle.
   */
  holdNextStart(): { readonly reached: Promise<void>; release(): void };
}

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

export function createGoalWorld(options: GoalWorldOptions): GoalWorld {
  const { clock } = options;
  const goalRunId = GOAL_RUN_ID;
  let stored: GoalWorkflowRecord = {
    goalRunId,
    status: 'pending',
    transitionSeq: 0,
    validator: { name: 'test-validator', version: '1.0.0' },
    ...(options.validatorTimeoutMs === undefined
      ? {}
      : { validatorTimeoutMs: options.validatorTimeoutMs }),
    bounds: options.bounds ?? { maximumAttempts: 3, maximumTotalDurationMs: 3_600_000 },
    ...(options.retryOn === undefined ? {} : { retryPolicy: { retryOn: options.retryOn } }),
    attempts: [],
    usage: { attempts: 0, steps: 0, tokens: 0, durationMs: 0 },
    createdAt: iso(clock.getNow()),
  };
  let currentTransition: { transitionId: string; seq: number; to: GoalRunStatus } | undefined;
  let missing = false;
  let frozenNowMs: number | undefined;
  let nextStartFailure: string | undefined;
  let forced: GoalWorkflowCommit | undefined;
  const beforeCommit = new Map<GoalRunStatus, () => void>();
  const crashes = new Map<string, PendingCrash>();
  const runs = new Map<string, { sessionId: string; aborted: boolean }>();
  let validatorCalls = 0;
  let startGate: { signalReached: () => void; released: Promise<void> } | undefined;

  const transitions: GoalWorkflowTransition[] = [];
  const calls: string[] = [];
  const claims = new Set<string>();
  const startedRuns: string[] = [];
  const abortedRuns: string[] = [];
  const startSignals: (AbortSignal | undefined)[] = [];
  const validatorTimeouts: (number | undefined)[] = [];
  const startFeedback = new Map<number, string | undefined>();
  const validatorOutcomes: ProjectedValidatorOutcome[] = [];

  async function point(label: CrashLabel): Promise<void> {
    const crash = crashes.get(label);
    if (crash === undefined || crash.fired) return;
    crash.fired = true;
    crash.signalReached();
    await new Promise<never>(() => {});
  }

  function apply(request: GoalWorkflowTransition): GoalWorkflowCommit {
    const current = stored;
    if (currentTransition?.transitionId === request.transitionId) {
      return currentTransition.to === request.to && currentTransition.seq === request.seq
        ? { status: 'duplicate' }
        : { status: 'stale' };
    }
    if (current.transitionSeq !== request.seq - 1) return { status: 'stale' };
    if (TERMINAL_STATUSES.includes(current.status))
      return { status: 'rejected', reason: 'terminal' };
    if (current.cancellation !== undefined && request.to !== 'canceled') {
      return { status: 'rejected', reason: 'cancellation-requested' };
    }
    if (!canTransitionGoalRun(current.status, request.to)) {
      return { status: 'rejected', reason: 'illegal-transition' };
    }
    const terminal = TERMINAL_STATUSES.includes(request.to);
    if (
      terminal
        ? request.terminalReason === undefined ||
          TERMINAL_STATUS_BY_REASON[request.terminalReason] !== request.to
        : request.terminalReason !== undefined
    ) {
      return { status: 'rejected', reason: 'invalid-terminal-reason' };
    }
    let attempts: readonly GoalWorkflowAttempt[] = current.attempts;
    const patch = request.attempt;
    if (patch !== undefined) {
      if (
        patch.attemptIndex > current.attempts.length ||
        patch.attemptId !== identifiers.attemptId(goalRunId, patch.attemptIndex)
      ) {
        return { status: 'rejected', reason: 'invalid-attempt' };
      }
      const recorded = current.attempts[patch.attemptIndex]?.validation;
      if (recorded !== undefined && recorded.decisionId !== patch.validation?.decisionId) {
        return { status: 'rejected', reason: 'decision-already-recorded' };
      }
      const next = [...current.attempts];
      next[patch.attemptIndex] = patch;
      attempts = next;
    }
    const { active: _active, terminalReason: _reason, failureDetail: _detail, ...rest } = current;
    const active = request.active === undefined ? current.active : (request.active ?? undefined);
    stored = {
      ...rest,
      status: request.to,
      transitionSeq: request.seq,
      attempts,
      usage: request.usage ?? current.usage,
      ...(request.terminalReason === undefined ? {} : { terminalReason: request.terminalReason }),
      ...(request.failureDetail === undefined ? {} : { failureDetail: request.failureDetail }),
      ...(active === undefined ? {} : { active }),
    };
    currentTransition = { transitionId: request.transitionId, seq: request.seq, to: request.to };
    transitions.push(structuredClone(request));
    return { status: 'applied' };
  }

  async function commitTransition(request: GoalWorkflowTransition): Promise<GoalWorkflowCommit> {
    const hook = beforeCommit.get(request.to);
    if (hook !== undefined) {
      beforeCommit.delete(request.to);
      hook();
    }
    const result = forced ?? apply(request);
    calls.push(
      `commit:${request.to}:${result.status === 'rejected' ? result.reason : result.status}`,
    );
    await point(`commit:${request.to}`);
    return result;
  }

  async function startAttempt(
    request: GoalWorkflowStartRequest,
    signal?: AbortSignal,
  ): Promise<GoalWorkflowStart> {
    startSignals.push(signal);
    calls.push(`start:${request.attemptIndex}`);
    options.onStart?.();
    startFeedback.set(request.attemptIndex, request.feedback);
    if (nextStartFailure !== undefined) {
      const detail = nextStartFailure;
      nextStartFailure = undefined;
      return { status: 'failed', detail };
    }
    // The real port's pre-write stand-down, with the deadline measured by the
    // controller's own function: nothing is claimed or started for a goal that
    // is over, whatever the controller's last read said.
    if (isDeadlineElapsed(stored, clock.getNow())) return { status: 'stood-down' };
    // A claim without a started run is the state a crash between the two leaves.
    if (!claims.has(request.runId)) {
      claims.add(request.runId);
      await point('start:claimed');
    }
    const existing = runs.get(request.runId);
    if (existing !== undefined) return { status: 'adopted', sessionId: existing.sessionId };
    const sessionId = `session-${request.runId}`;
    runs.set(request.runId, { sessionId, aborted: false });
    startedRuns.push(request.runId);
    await point('start:started');
    if (startGate !== undefined) {
      const gate = startGate;
      startGate = undefined;
      gate.signalReached();
      await gate.released;
    }
    return { status: 'started', sessionId };
  }

  async function runValidator(request: GoalWorkflowValidatorRequest) {
    calls.push(`validate:${request.attemptIndex}`);
    validatorTimeouts.push(request.validatorTimeoutMs);
    const outcome = validatorOutcomes[validatorCalls] ?? { kind: 'pass', evidence: [] };
    validatorCalls += 1;
    options.onValidate?.();
    await point('validate');
    return {
      identity: request.validator,
      startedAt: iso(clock.getNow()),
      completedAt: iso(clock.getNow()),
      outcome,
    } as const;
  }

  async function abortAttempt(request: GoalWorkflowAbortRequest): Promise<void> {
    calls.push(`abort:${request.attemptIndex}`);
    const run = runs.get(request.runId);
    if (run !== undefined && !run.aborted) {
      run.aborted = true;
      abortedRuns.push(request.runId);
    }
    await point('abort');
  }

  const ports: GoalWorkflowPorts = {
    identifiers,
    loadGoalState: (): Promise<{ record: GoalWorkflowRecord | undefined; nowMs: number }> => {
      calls.push('load');
      return Promise.resolve({
        record: missing ? undefined : structuredClone(stored),
        nowMs: frozenNowMs ?? clock.getNow(),
      });
    },
    commitTransition,
    startAttempt,
    runValidator,
    abortAttempt,
  };

  return {
    ports,
    record: () => structuredClone(stored),
    transitions,
    calls,
    claims,
    startedRuns,
    abortedRuns,
    startSignals,
    validatorTimeouts,
    startFeedback,
    validatorOutcomes,
    requestCancellation() {
      stored = { ...stored, cancellation: { requestedAt: iso(clock.getNow()) } };
    },
    patchRecord(patch) {
      stored = { ...stored, ...patch };
    },
    failNextStart(detail) {
      nextStartFailure = detail;
    },
    beforeNextCommit(to, action) {
      beforeCommit.set(to, action);
    },
    forceCommit(next) {
      forced = next;
    },
    freezeNow(nowMs) {
      frozenNowMs = nowMs;
    },
    makeRecordMissing() {
      missing = true;
    },
    holdNextStart() {
      let signalReached: () => void = () => {};
      let release: () => void = () => {};
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      startGate = { signalReached, released };
      return { reached, release };
    },
    crashAfter(label) {
      let signalReached: () => void = () => {};
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      crashes.set(label, { fired: false, signalReached });
      return { reached };
    },
  };
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export const CLAIM_TTL_MS = 30;
export const CLAIM_RENEW_INTERVAL_MS = 10;
/** The manual-clock advance after which a surviving engine may take over a crashed one's claims. */
export const TAKEOVER_ADVANCE_MS = CLAIM_TTL_MS + 2 * CLAIM_RENEW_INTERVAL_MS + 1;

export interface GoalHarness {
  readonly storage: MemoryStorage;
  readonly clock: ManualClock;
  readonly world: GoalWorld;
  /** What every engine over this harness builds its workflow with. */
  readonly workflowOptions: GoalWorkflowOptions;
}

export function createHarness(
  options: Omit<GoalWorldOptions, 'clock'> & { readonly startAttemptTimeoutMs?: number } = {},
): GoalHarness {
  const clock = createManualClock();
  const { startAttemptTimeoutMs, ...worldOptions } = options;
  return {
    storage: new MemoryStorage(),
    clock,
    world: createGoalWorld({ ...worldOptions, clock }),
    workflowOptions: { startAttemptTimeoutMs },
  };
}

/** `createRunEngine` requires the `agentRun` workflow; these tests never start one. */
const idleAgentRun = () =>
  workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    return yield* ctx.run(() => Promise.resolve('idle'));
  });

export interface GoalEngineOptions {
  readonly resolveWorkflowServices?: Parameters<
    typeof createRunEngine
  >[0]['resolveWorkflowServices'];
}

/** One engine over the harness's shared storage, clock, and world. */
export function createGoalEngine(harness: GoalHarness, options: GoalEngineOptions = {}) {
  return createRunEngine({
    storage: harness.storage,
    runWorkflow: idleAgentRun(),
    goalWorkflow: createGoalWorkflow(harness.world.ports, harness.workflowOptions),
    recover: false,
    ownership: 'workflow-lease',
    workflowClaimTtlMs: CLAIM_TTL_MS,
    workflowClaimRenewIntervalMs: CLAIM_RENEW_INTERVAL_MS,
    getNow: harness.clock.getNow,
    backgroundTasks: 'manual',
    ...(options.resolveWorkflowServices === undefined
      ? {}
      : { resolveWorkflowServices: options.resolveWorkflowServices }),
  });
}

type EngineHandle = Awaited<ReturnType<typeof createGoalEngine>>;

export const startGoalWorkflow = (run: EngineHandle) =>
  run.engine.start('goalRun', { goalRunId: GOAL_RUN_ID }, { id: GOAL_WORKFLOW_ID });

/** Delivers the attempt's terminal signal with a stable signal id, as Bureau's forwarder does. */
export function finishAttempt(
  run: EngineHandle,
  attemptIndex: number,
  payload: Partial<GoalAttemptTerminalSignal> = {},
): Promise<void> {
  const body: GoalAttemptTerminalSignal = {
    finishReason: 'stop-condition',
    steps: 2,
    tokens: 100,
    ...payload,
  };
  return run.engine.signal(GOAL_WORKFLOW_ID, goalAttemptTerminalSignalName(attemptIndex), body, {
    signalId: `attempt-terminal:${GOAL_RUN_ID}:${attemptIndex}`,
  });
}

/** Simulates a process crash of `crashed` and the takeover of its workflows by a fresh engine. */
export async function crashAndAdopt(
  harness: GoalHarness,
  crashed: EngineHandle,
  options: GoalEngineOptions = {},
) {
  crashed.engine[Symbol.dispose]();
  const takeoverNow = harness.clock.advance(TAKEOVER_ADVANCE_MS);
  const adopter = await createGoalEngine(harness, options);
  await adopter.engine.runMaintenance(takeoverNow);
  const handle = await adopter.engine.resume(GOAL_WORKFLOW_ID);
  return { adopter, handle };
}

/** The statuses the applied transitions moved through, in order. */
export const statusesOf = (world: GoalWorld): GoalRunStatus[] =>
  world.transitions.map((transition) => transition.to);
