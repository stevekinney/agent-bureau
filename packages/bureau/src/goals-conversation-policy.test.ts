/**
 * COR-851 — the three conversation policies of a durable goal, end to end.
 *
 * What each policy promises is what a retry's generate call is given, so every
 * test reads that: the scripted agent records the transcript of each call. The
 * restart tests then kill a process in the middle of a retry and check the
 * transcript the next process resumes it with, and the session it leaves
 * behind, which must hold one run per attempt and each message once.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { FreshAttemptSourceResolver, SessionStore } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { GoalState } from './goal-state';
import {
  createCheckValidator,
  createDiagnostics,
  createTestDatabase,
  durableIds,
  freshHandoff,
  goalRequest,
  hangForever,
  pollUntil,
  scriptedGenerate,
  TERMINAL_STATUSES,
  type TestDatabase,
  transcriptOf,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { bootOver } from './testing/goal-recovery-fixtures.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
let database: TestDatabase = createTestDatabase('unset');

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await database.remove();
});

async function boot(options: Parameters<typeof createBureau>[0]) {
  const bureau = await createBureau({
    storage: { type: 'memory' },
    durableExecution: true,
    onDiagnostic: createDiagnostics().onDiagnostic,
    ...options,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

async function ended(bureau: Bureau, goalRunId = 'g1'): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get(goalRunId);
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  if (latest === undefined) throw new Error(`goal ${goalRunId} never ended`);
  return latest;
}

function sessionsOf(bureau: Bureau): SessionStore {
  if (bureau.sessionStore === undefined) throw new Error('the bureau has no session store');
  return bureau.sessionStore;
}

/** The session's runs as `[runId, status]`, and its transcript. */
async function describeSession(sessions: SessionStore, sessionId: string) {
  const session = await sessions.load(sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is missing`);
  return {
    runs: session.runs.map((run) => [run.runId, run.status]),
    transcript: transcriptOf({
      getMessages: () =>
        session.conversationHistory.ids.map((id) => session.conversationHistory.messages[id]!),
    }),
  };
}

const WORK = 'user: work';
const NOPE = 'assistant: nope';
const DONE = 'assistant: done';

describe('a durable goal under the continue policy', () => {
  it('runs every attempt in one session, appending the feedback as the next user turn', async () => {
    const seen: string[][] = [];
    const bureau = await boot({
      agents: { worker: workerAgent(scriptedGenerate(['nope', 'nope', 'done'], seen)) },
      validators: [createCheckValidator()],
    });

    await bureau.goals.create(goalRequest({ conversationPolicy: { kind: 'continue' } }));
    const goal = await ended(bureau);

    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 3 } });
    // Each retry sees every earlier turn, and its own turn is the feedback alone.
    expect(seen).toEqual([
      [WORK],
      [WORK, NOPE, 'user: say done'],
      [WORK, NOPE, 'user: say done', NOPE, 'user: say done'],
    ]);
    expect(goal.attempts.map((attempt) => attempt.sessionId)).toEqual([
      'goal-g1-s0',
      'goal-g1-s0',
      'goal-g1-s0',
    ]);
    // The one session holds all three runs and the whole conversation, once.
    expect(await describeSession(sessionsOf(bureau), 'goal-g1-s0')).toEqual({
      runs: [
        ['goal-g1-a0', 'completed'],
        ['goal-g1-a1', 'completed'],
        ['goal-g1-a2', 'completed'],
      ],
      transcript: [WORK, NOPE, 'user: say done', NOPE, 'user: say done', DONE],
    });
  });

  it("records the goal's principal as the authority over its session", async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(scriptedGenerate(['done'])) },
      validators: [createCheckValidator()],
    });

    await bureau.goals.create(goalRequest({ principal: 'alice' }));
    await ended(bureau);

    const session = await sessionsOf(bureau).load('goal-g1-s0');
    expect(session?.metadata).toMatchObject({
      goalRunId: 'g1',
      lastRequestAuthority: { principalId: 'alice' },
    });
  });
});

describe('a durable goal under the fork-from-baseline policy', () => {
  it('forks the baseline run before each retry, so a retry never sees a later attempt', async () => {
    const seen: string[][] = [];
    const bureau = await boot({
      agents: { worker: workerAgent(scriptedGenerate(['nope', 'nope', 'done'], seen)) },
      validators: [createCheckValidator()],
    });

    await bureau.goals.create(
      goalRequest({ conversationPolicy: { kind: 'fork-from-baseline', throughRun: 0 } }),
    );
    const goal = await ended(bureau);

    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 3 } });
    const retry = [WORK, NOPE, 'user: work\n\nsay done'];
    // Both retries fork through run 0, so the second does not see the first's
    // own reply: that is the difference from `continue`.
    expect(seen).toEqual([[WORK], retry, retry]);
    expect(goal.attempts.map((attempt) => attempt.sessionId)).toEqual([
      'goal-g1-s0',
      'goal-g1-s1',
      'goal-g1-s2',
    ]);
    const sessions = sessionsOf(bureau);
    expect(await describeSession(sessions, 'goal-g1-s0')).toEqual({
      runs: [['goal-g1-a0', 'completed']],
      transcript: [WORK, NOPE],
    });
    expect(await describeSession(sessions, 'goal-g1-s1')).toEqual({
      runs: [['goal-g1-a1', 'completed']],
      transcript: [WORK, NOPE, 'user: work\n\nsay done', NOPE],
    });
    expect(await describeSession(sessions, 'goal-g1-s2')).toEqual({
      runs: [['goal-g1-a2', 'completed']],
      transcript: [WORK, NOPE, 'user: work\n\nsay done', DONE],
    });
  });

  it('refuses a baseline run no durable goal can have, before any attempt is spent on it', async () => {
    const seen: string[][] = [];
    const bureau = await boot({
      agents: { worker: workerAgent(scriptedGenerate(['nope'], seen)) },
      validators: [createCheckValidator()],
    });

    const outcome = await bureau.goals.create(
      goalRequest({ conversationPolicy: { kind: 'fork-from-baseline', throughRun: 5 } }),
    );

    expect(outcome).toMatchObject({ outcome: 'rejected', code: 'invalid-configuration' });
    expect((outcome as { reason: string }).reason).toContain('throughRun');
    expect(await bureau.goals.list()).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('a durable goal under the fresh-from-artifact policy', () => {
  it('starts every retry in a new conversation built from the instructions and the artifact', async () => {
    const seen: string[][] = [];
    const { artifact, resolveSource } = await freshHandoff('Make the check pass.');
    const bureau = await boot({
      agents: { worker: workerAgent(scriptedGenerate(['nope', 'nope', 'done'], seen)) },
      validators: [createCheckValidator()],
      resolveFreshAttemptSource: resolveSource,
    });

    const created = await bureau.goals.create(
      goalRequest({
        conversationPolicy: { kind: 'fresh-from-artifact', artifact },
        instructions: 'Be careful.',
      }),
    );
    expect(created).toMatchObject({ outcome: 'created' });
    const goal = await ended(bureau);

    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 3 } });
    expect(seen[0]).toEqual([WORK]);
    for (const retry of seen.slice(1)) {
      // The instructions, the artifact's rendering, and the prompt: no transcript.
      expect(retry).toHaveLength(3);
      expect(retry[0]).toBe('system: Be careful.');
      expect(retry[1]).toContain('Make the check pass.');
      expect(retry[2]).toBe(WORK);
      expect(retry.join('\n')).not.toContain('nope');
      expect(retry.join('\n')).not.toContain('say done');
    }
    expect(seen[1]).toEqual(seen[2]);
    expect(goal.attempts.map((attempt) => attempt.sessionId)).toEqual([
      'goal-g1-s0',
      'goal-g1-s1',
      'goal-g1-s2',
    ]);
  });

  it('refuses the goal when nothing can vouch for the artifact', async () => {
    const { artifact } = await freshHandoff();
    const bureau = await boot({
      agents: { worker: workerAgent(scriptedGenerate(['done'])) },
      validators: [createCheckValidator()],
    });

    const outcome = await bureau.goals.create(
      goalRequest({
        conversationPolicy: { kind: 'fresh-from-artifact', artifact },
        instructions: 'Be careful.',
      }),
    );

    expect(outcome).toMatchObject({ outcome: 'rejected', code: 'invalid-configuration' });
    expect((outcome as { reason: string }).reason).toContain('source-unresolved');
    expect(await bureau.goals.list()).toEqual([]);
  });
});

describe('a repeated create of a fresh-from-artifact goal after its artifact expired', () => {
  const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

  async function bootExpiring() {
    const runtime = createManualRuntimeServices();
    const { artifact, resolveSource } = await freshHandoff(
      'Make the check pass.',
      new Date(runtime.clock.now()),
    );
    const bureau = await boot({
      agents: { worker: workerAgent(hangForever) },
      validators: [createCheckValidator()],
      resolveFreshAttemptSource: resolveSource,
      runtime,
    });
    const request = goalRequest({
      conversationPolicy: { kind: 'fresh-from-artifact', artifact },
      instructions: 'Be careful.',
    });
    return { bureau, runtime, request };
  }

  it('adopts the goal it already recorded, because the retention window is a consumption rule', async () => {
    const { bureau, runtime, request } = await bootExpiring();
    expect(await bureau.goals.create(request)).toMatchObject({ outcome: 'created' });

    runtime.setTime(runtime.clock.now() + EIGHT_DAYS_MS);

    expect(await bureau.goals.create(request)).toMatchObject({
      outcome: 'existing',
      goal: { goalRunId: 'g1' },
    });
  });

  it('still refuses a new goal whose artifact has expired, and names a different request under a stored id a conflict', async () => {
    const { bureau, runtime, request } = await bootExpiring();
    expect(await bureau.goals.create(request)).toMatchObject({ outcome: 'created' });

    runtime.setTime(runtime.clock.now() + EIGHT_DAYS_MS);

    // The id is taken, so the stored record decides before the artifact is read.
    expect(await bureau.goals.create({ ...request, prompt: 'something else' })).toMatchObject({
      outcome: 'conflict',
      goal: { goalRunId: 'g1' },
    });
    expect(await bureau.goals.create({ ...request, goalRunId: 'g2' })).toMatchObject({
      outcome: 'rejected',
      code: 'invalid-configuration',
    });
  });
});

// ---------------------------------------------------------------------------
// A process that dies in the middle of a retry
// ---------------------------------------------------------------------------

/**
 * Bureau A finishes attempt 0 (a failing answer) and then hangs in attempt 1,
 * which is where the process "dies". Bureau B boots over the same file, answers
 * `done`, and records every transcript its generate is given.
 */
async function restartDuringRetry(
  request: Parameters<Bureau['goals']['create']>[0],
  options: { resolveFreshAttemptSource?: FreshAttemptSourceResolver } = {},
) {
  database = createTestDatabase('conversation');
  let calls = 0;
  const { bureau: dead } = await bootOver({
    path: database.path,
    agents: {
      worker: workerAgent((input) => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ content: 'nope', toolCalls: [] })
          : hangForever(input);
      }),
    },
    validators: [createCheckValidator()],
    ...options,
  });
  cleanups.push(() => dead.dispose());
  await dead.goals.create(request);
  const reachedRetry = await pollUntil(async () => {
    const goal = await dead.goals.get('g1');
    return goal?.attempts[1]?.status === 'running';
  });
  expect(reachedRetry).toBe(true);

  const seen: string[][] = [];
  const { bureau } = await bootOver({
    path: database.path,
    agents: { worker: workerAgent(scriptedGenerate(['done'], seen)) },
    validators: [createCheckValidator()],
    ...options,
  });
  cleanups.push(() => bureau.dispose());
  const goal = await ended(bureau);
  return { bureau, goal, seen };
}

describe('a goal whose process died during a retry', () => {
  it('under continue, resumes the retry in the same session without a second run or a repeated turn', async () => {
    const { bureau, goal, seen } = await restartDuringRetry(goalRequest());

    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 2 } });
    // Attempt 0's transcript and the feedback turn survived the crash.
    expect(seen).toEqual([[WORK, NOPE, 'user: say done']]);
    expect(await durableIds(bureau, 'goal-g1-a')).toHaveLength(2);
    expect(await describeSession(sessionsOf(bureau), 'goal-g1-s0')).toEqual({
      runs: [
        ['goal-g1-a0', 'completed'],
        ['goal-g1-a1', 'completed'],
      ],
      transcript: [WORK, NOPE, 'user: say done', DONE],
    });
  });

  it('under fork-from-baseline, resumes the retry in its fork and leaves the baseline session alone', async () => {
    const { bureau, goal, seen } = await restartDuringRetry(
      goalRequest({ conversationPolicy: { kind: 'fork-from-baseline', throughRun: 0 } }),
    );

    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 2 } });
    expect(seen).toEqual([[WORK, NOPE, 'user: work\n\nsay done']]);
    expect(await durableIds(bureau, 'goal-g1-a')).toHaveLength(2);
    const sessions = sessionsOf(bureau);
    expect(await describeSession(sessions, 'goal-g1-s0')).toEqual({
      runs: [['goal-g1-a0', 'completed']],
      transcript: [WORK, NOPE],
    });
    expect(await describeSession(sessions, 'goal-g1-s1')).toEqual({
      runs: [['goal-g1-a1', 'completed']],
      transcript: [WORK, NOPE, 'user: work\n\nsay done', DONE],
    });
  });

  it('under fresh-from-artifact, resumes the retry in its fresh session with no inherited transcript', async () => {
    const { artifact, resolveSource } = await freshHandoff();
    const { bureau, goal, seen } = await restartDuringRetry(
      goalRequest({
        conversationPolicy: { kind: 'fresh-from-artifact', artifact },
        instructions: 'Be careful.',
      }),
      { resolveFreshAttemptSource: resolveSource },
    );

    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 2 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('system: Be careful.');
    expect(seen[0]?.at(-1)).toBe(WORK);
    expect(seen[0]?.join('\n')).not.toContain('nope');
    expect(await durableIds(bureau, 'goal-g1-a')).toHaveLength(2);
    const fresh = await describeSession(sessionsOf(bureau), 'goal-g1-s1');
    expect(fresh.runs).toEqual([['goal-g1-a1', 'completed']]);
    expect(fresh.transcript.at(-1)).toBe(DONE);
    expect(fresh.transcript.filter((line) => line === WORK)).toHaveLength(1);
  });
});
