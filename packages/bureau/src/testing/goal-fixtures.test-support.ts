/**
 * COR-851 — shared fixtures for the `bureau.goals` tests.
 *
 * The restart tests follow `bureau-children.test.ts`: bureau A runs until a
 * durable step is in flight and then "dies" (its generate never resolves and it
 * is deliberately not disposed), and bureau B boots over the same SQLite file
 * with `ownership: 'none'`, so there is no claim to wait out. Everything B
 * knows about A's goals it learns from storage.
 */

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  finalizeFreshAttemptHandoffArtifact,
  type FreshAttemptSourceResolver,
  type GenerateFunction,
  type GoalBudget,
  stopWhen,
  type Validator,
  type ValidatorInput,
  type ValidatorOutcome,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { expect } from 'bun:test';

import type { GoalState } from '../goal-state';
import type { BureauGoalRequest } from '../goal-types';
import type { Bureau, BureauDiagnostic } from '../types';

let databaseCounter = 0;

export interface TestDatabase {
  readonly path: string;
  remove(): Promise<void>;
}

/**
 * The real clock and timers, reached through the runtime services. Several goal tests
 * need real time (SQLite's completion callbacks, a record dated now), and a bare
 * `new Date()` or `setTimeout` in a deterministic directory is what the determinism
 * rule refuses.
 */
const realRuntime = createDefaultRuntimeServices();

/** The wall clock as an ISO timestamp. */
export function currentIsoTimestamp(): string {
  return realRuntime.clock.nowISO();
}

/** The wall clock in epoch milliseconds. */
export function currentEpochMilliseconds(): number {
  return realRuntime.clock.now();
}

export function createTestDatabase(label: string): TestDatabase {
  const path = join(tmpdir(), `bureau-goals-${label}-${process.pid}-${databaseCounter++}.sqlite`);
  return {
    path,
    async remove() {
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    },
  };
}

export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  attempts = 1000,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    // A tiny real delay: SQLite's completion callbacks starve under a zero-delay loop.
    await new Promise<void>((resolve) => realRuntime.timers.setTimeout(resolve, 2));
    await yieldToPortableEventLoop();
  }
  return check();
}

export interface Latch {
  readonly promise: Promise<void>;
  release(): void;
}

export function createLatch(): Latch {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Collects diagnostics instead of printing them. */
export function createDiagnostics() {
  const collected: BureauDiagnostic[] = [];
  return {
    onDiagnostic: (diagnostic: BureauDiagnostic): void => {
      collected.push(diagnostic);
    },
    all: () => [...collected],
    scope: (scope: string) => collected.filter((diagnostic) => diagnostic.scope === scope),
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Never answers, but stops when its run is aborted, as a real provider call does. */
export const hangUntilAborted: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/** Never answers and never stops: the run of a process that died. */
export const hangForever: GenerateFunction = () => new Promise(() => {});

export function workerAgent(generate: GenerateFunction, name = 'worker') {
  return createAgent({ name, generate, stopWhen: stopWhen.noToolCalls() });
}

/** Answers with `content` and records every prompt it was given. */
export function answering(content: string, prompts: string[] = []): GenerateFunction {
  return ({ conversation }) => {
    const last = conversation.getMessages().at(-1);
    prompts.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content));
    return Promise.resolve({ content, toolCalls: [] });
  };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export const CHECK = { name: 'check', version: '1' } as const;

export interface CheckValidatorOptions {
  readonly version?: string;
  readonly determinism?: Validator['determinism'];
  /** Runs before the verdict; a latch here parks the goal in `evaluating`. */
  readonly before?: (input: ValidatorInput) => Promise<void> | void;
  readonly calls?: ValidatorInput[];
}

/** Passes when the attempt's content says `done`; otherwise fails retryably with feedback. */
export function createCheckValidator(options: CheckValidatorOptions = {}): Validator {
  return {
    identity: { name: CHECK.name, version: options.version ?? CHECK.version },
    determinism: options.determinism ?? 'deterministic',
    async validate(input): Promise<ValidatorOutcome> {
      options.calls?.push(input);
      await options.before?.(input);
      return input.result.content.includes('done')
        ? {
            kind: 'pass',
            evidence: [{ source: 'check', detail: { content: input.result.content } }],
          }
        : { kind: 'fail', feedback: 'say done', evidence: [], retryable: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const GOAL_BOUNDS: GoalBudget = { maximumAttempts: 3, maximumTotalSteps: 100 };

export function goalRequest(
  overrides: Partial<BureauGoalRequest<'worker'>> = {},
): BureauGoalRequest<'worker'> {
  return {
    agentName: 'worker',
    prompt: 'work',
    identity: { name: 'goal', version: '1' },
    validator: CHECK,
    bounds: GOAL_BOUNDS,
    retryPolicy: { retryOn: ['validator-fail-retryable'] },
    goalRunId: 'g1',
    ...overrides,
  };
}

type CancelOutcome = Awaited<ReturnType<Bureau['goals']['cancel']>>;

/**
 * Cancels a goal and retries until it answers `canceled`. Under the default
 * ownership the controller's finalizer runs in the background after the hard
 * cancel, so the first read may find it still owed: `cancellation-pending`,
 * awaiting only the finalizer. Anything else unfinished, or a failed
 * finalizer, is a defect and fails the test.
 */
export async function cancelUntilSettled(
  bureau: Bureau,
  goalRunId = 'g1',
  options?: Parameters<Bureau['goals']['cancel']>[1],
): Promise<{ first: CancelOutcome; settled: CancelOutcome }> {
  const first = await bureau.goals.cancel(goalRunId, options);
  let latest = first;
  const done = await pollUntil(async () => {
    if (latest.outcome === 'canceled') return true;
    expect(latest).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['finalizer'] });
    latest = await bureau.goals.cancel(goalRunId, options);
    return false;
  });
  expect(done).toBe(true);
  return { first, settled: latest };
}

export const TERMINAL_STATUSES = ['succeeded', 'exhausted', 'failed', 'canceled'] as const;

/** The goal's status, or `undefined` when there is no such goal. */
export async function goalStatus(
  bureau: Bureau,
  goalRunId = 'g1',
): Promise<GoalState['status'] | undefined> {
  const goal = await bureau.goals.get(goalRunId);
  return goal?.status;
}

/** The engine's own status for a durable workflow, or `undefined` when there is none. */
export async function workflowStatus(
  bureau: Bureau,
  workflowId: string,
): Promise<string | undefined> {
  const state = await bureau.getDurableRun(workflowId);
  return state?.status;
}

/** The ids of the durable workflows whose id starts with `prefix`. */
export async function durableIds(bureau: Bureau, prefix: string): Promise<string[]> {
  const page = await bureau.listDurableRuns();
  return (page?.items ?? []).filter((item) => item.id.startsWith(prefix)).map((item) => item.id);
}

/** Every goal id `bureau.goals.list` answers for. */
export async function listedIds(
  bureau: Bureau,
  options?: Parameters<Bureau['goals']['list']>[0],
): Promise<string[]> {
  const goals = await bureau.goals.list(options);
  return goals.map((goal) => goal.goalRunId);
}

/** The status of each attempt a goal has recorded. */
export async function attemptStatuses(bureau: Bureau, goalRunId = 'g1'): Promise<string[]> {
  const goal = await bureau.goals.get(goalRunId);
  return (goal?.attempts ?? []).map((attempt) => attempt.status);
}

/** The last message the model was shown, as text. */
export function lastPromptOf(conversation: {
  getMessages(): readonly { content: unknown }[];
}): string {
  const content = conversation.getMessages().at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** One line per message, `role: text`, in transcript order. */
export function transcriptOf(conversation: {
  getMessages(): readonly { role: string; content: unknown }[];
}): string[] {
  return conversation
    .getMessages()
    .map(
      ({ role, content }) =>
        `${role}: ${typeof content === 'string' ? content : JSON.stringify(content)}`,
    );
}

/**
 * Answers `replies[n]` to its nth call (the last reply once they run out) and
 * records the transcript that call was given, so a test can say exactly what
 * each attempt saw.
 */
export function scriptedGenerate(
  replies: readonly string[],
  seen: string[][] = [],
): GenerateFunction {
  let calls = 0;
  return ({ conversation }) => {
    seen.push(transcriptOf(conversation));
    const reply = replies[Math.min(calls, replies.length - 1)] ?? '';
    calls += 1;
    return Promise.resolve({ content: reply, toolCalls: [] });
  };
}

export const HANDOFF_ACTOR = 'operator:test';

/** A valid COR-894 handoff artifact dated now, and the resolver that vouches for its source run. */
export async function freshHandoff(
  objective = 'Make the check pass.',
  at = new Date(currentEpochMilliseconds()),
) {
  const artifact = await finalizeFreshAttemptHandoffArtifact({
    artifactId: 'handoff-1',
    revision: 1,
    objective,
    successRevision: 'check#1',
    constraints: ['Say done.'],
    completedWork: ['Tried once.'],
    validatedFacts: [],
    evidenceReferences: [],
    knownFailures: [],
    unresolvedQuestions: [],
    nextRequestedAction: 'Say the word done.',
    allowedCarryForwardContext: [],
    producer: { agentName: 'worker', runId: 'source:0', sessionId: 'source' },
    sourceRunOrAttempt: { sessionId: 'source', runId: 'source:0', sequence: 0 },
    timestamp: at.toISOString(),
    lineage: { sourceRevision: 1 },
    provenance: { producedAt: at.toISOString(), producingActor: HANDOFF_ACTOR },
  });
  const resolveSource: FreshAttemptSourceResolver = () => ({
    epoch: {
      epochId: 'epoch-1',
      sources: [],
      baselineDigest: '0'.repeat(16),
      firstConsumedBy: { runId: 'source:0', step: 0, attempt: 0 },
    },
    permittedActors: [HANDOFF_ACTOR],
  });
  return { artifact, resolveSource };
}
