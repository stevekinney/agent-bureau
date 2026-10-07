/**
 * COR-1419 — a live run-frame subscriber hears when a run ends because it
 * exceeded a budget.
 *
 * The notification is derived from Operative's terminal result, and Bureau
 * decides when a run's frame forwarder stops listening. A test that hands
 * `createRunFrameForwarder` a bare `ActiveRun` cannot see that decision, so
 * these tests drive the whole Bureau lifecycle and read the frames a
 * `subscribeLiveFrames` listener receives, for both run drivers. A run that a
 * restarted Bureau reattaches replays its memoized steps and dispatches no step
 * events, so it is covered separately below.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  BudgetExceededError,
  type GenerateFunction,
  type RunFrame,
  type StopCondition,
} from '@lostgradient/operative';
import { resolveStorage } from '@lostgradient/weft';
import { createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { waitForCondition, waitForRunState } from './test';
import type { BureauOptions } from './types';

const ORIGIN = '2026-10-03T00:00:00.000Z';

type NotificationFrame = Extract<RunFrame, { type: 'notification' }>;

const noopTool = createTool({
  name: 'noop',
  description: 'does nothing',
  input: z.object({}),
  execute: async () => ({}),
});

/** Step 0 calls a tool, so the failing step is 1 and the frame's step is not a default of 0. */
function generateThenFail(failure: unknown): GenerateFunction {
  return async ({ step }) =>
    step === 0
      ? { content: '', toolCalls: [{ name: 'noop', arguments: {} }] }
      : Promise.reject(failure);
}

const generateDone: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

const drivers: Array<{
  name: string;
  options: Pick<BureauOptions, 'storage' | 'durableExecution'>;
}> = [
  { name: 'in-memory driver', options: {} },
  { name: 'durable driver', options: { storage: { type: 'memory' }, durableExecution: true } },
];

async function collectRunFrames(
  generate: GenerateFunction,
  driverOptions: Pick<BureauOptions, 'storage' | 'durableExecution'>,
): Promise<{ frames: RunFrame[]; finishReason: string | undefined }> {
  const bureau = await createBureau({
    agents: {},
    generate,
    toolbox: createToolbox<readonly Tool[]>([noopTool]),
    runtime: createManualRuntimeServices({ origin: ORIGIN }),
    ...driverOptions,
  });
  try {
    const frames: RunFrame[] = [];
    const unsubscribe = bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'run-envelope') frames.push(frame.frame);
    });
    const summary = await bureau.createRun({ message: 'Go.' });
    const settled = await waitForRunState(bureau, summary.id);
    unsubscribe();
    return { frames, finishReason: settled.finishReason };
  } finally {
    await bureau.dispose();
  }
}

function budgetNotifications(frames: readonly RunFrame[]): NotificationFrame[] {
  return frames.filter(
    (frame): frame is NotificationFrame =>
      frame.type === 'notification' && frame.code === 'budget.exceeded',
  );
}

describe.each(drivers)('a Bureau run on the $name', ({ options }) => {
  it('announces one budget-exceeded notification immediately before run-finished', async () => {
    const { frames, finishReason } = await collectRunFrames(
      generateThenFail(new BudgetExceededError('token limit reached')),
      options,
    );

    expect(finishReason).toBe('budget-exceeded');
    const notifications = budgetNotifications(frames);
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.level).toBe('error');
    expect(notification.code).toBe('budget.exceeded');
    expect(notification.message).toBe('Budget exceeded');
    expect(notification.step).toBe(1);
    expect(notification.timestamp).toBe(Date.parse(ORIGIN));
    expect(frames[frames.indexOf(notification) + 1]?.type).toBe('run-finished');
    expect(frames.filter((frame) => frame.type === 'run-finished')).toHaveLength(1);
  });

  it('announces no budget notification for a run that finishes within budget', async () => {
    const { frames, finishReason } = await collectRunFrames(generateDone, options);

    expect(finishReason).not.toBe('budget-exceeded');
    expect(budgetNotifications(frames)).toEqual([]);
    expect(frames.at(-1)?.type).toBe('run-finished');
  });

  it('announces no budget notification for a run that fails for another reason', async () => {
    const { frames, finishReason } = await collectRunFrames(
      generateThenFail(new Error('provider unavailable')),
      options,
    );

    expect(finishReason).toBe('error');
    expect(budgetNotifications(frames)).toEqual([]);
    expect(frames.at(-1)?.type).toBe('run-finished');
  });
});

let recoveryDatabaseCounter = 0;

type WeftStorage = Awaited<ReturnType<typeof resolveStorage>>;

/**
 * Holds the first commit that marks a run's workflow terminal until `release` is called. Every
 * checkpoint write for the run (transcript, step records, cursor) precedes that commit, so a
 * commit that is never released models a process that dies after a run's terminal result was
 * computed but before it was committed: the stored workflow stays running with its failing step
 * already memoized. Releasing it later lets a test attach a subscriber before a replay can settle.
 *
 * Bureau never disposes a `Storage` instance the caller built, so the test that opens one owns
 * closing it. `disposals` counts the closes the wrapper forwards, which lets that test assert it
 * released every handle it opened.
 */
function holdFirstTerminalRunCommit(storage: WeftStorage): {
  storage: WeftStorage;
  reached: Promise<void>;
  release: () => void;
  disposals: () => number;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let armed = true;
  let disposals = 0;
  const held = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === Symbol.dispose) {
        return () => {
          disposals++;
          target[Symbol.dispose]();
        };
      }
      if (property === 'batch' || property === 'conditionalBatch') {
        const real = (target as unknown as Record<string, unknown>)[property] as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const operations = (property === 'conditionalBatch' ? args[1] : args[0]) as {
            type: string;
            key: string;
          }[];
          const commitsTerminalRun = operations.some(
            (operation) =>
              operation.type === 'put' && /^wf-terminal:[^:]+:run-/.test(operation.key),
          );
          if (commitsTerminalRun && armed) {
            armed = false;
            markReached();
            await gate;
          }
          return real.apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: held, reached, release, disposals: () => disposals };
}

const generateToolThenAnswer: GenerateFunction = async ({ step }) =>
  step === 0
    ? { content: '', toolCalls: [{ name: 'noop', arguments: {} }] }
    : { content: 'Working.', toolCalls: [] };

/** The documented hard-stop pattern: the failing step finishes, then the stop condition throws. */
const stopConditionThatThrowsAtStepOne: StopCondition = (stepResult) => {
  if (stepResult.step === 1) throw new BudgetExceededError('cost limit reached');
  return false;
};

/**
 * Both shapes fail at step 1, yet nothing in the terminal result tells them apart. A rejected
 * `generate` call leaves step 1 unrecorded (`steps` ends at index 0); a throwing stop condition
 * runs after step 1 was recorded (`steps` ends at index 1). That is why a reattached run, which
 * replays no step events, cannot name the failing step from its terminal result.
 */
const failureShapes: Array<{
  name: string;
  options: { generate: GenerateFunction; stopWhen?: StopCondition };
}> = [
  {
    name: 'a generate call rejects',
    options: { generate: generateThenFail(new BudgetExceededError('token limit reached')) },
  },
  {
    name: 'a stop condition throws',
    options: { generate: generateToolThenAnswer, stopWhen: stopConditionThatThrowsAtStepOne },
  },
];

describe.each(failureShapes)(
  'a Bureau that reattaches a budget-exceeded run after a restart when $name',
  ({ options }) => {
    it('announces the budget failure without claiming a step it cannot know', async () => {
      const databasePath = join(
        tmpdir(),
        `bureau-budget-exceeded-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
      );
      const crashed = holdFirstTerminalRunCommit(
        await resolveStorage({ type: 'sqlite', path: databasePath }),
      );
      let replayed: ReturnType<typeof holdFirstTerminalRunCommit> | undefined;
      let bureauA: Awaited<ReturnType<typeof createBureau>> | undefined;
      let bureauB: Awaited<ReturnType<typeof createBureau>> | undefined;

      try {
        // Bureau A fails the run at step 1 and never learns the outcome: its terminal commit
        // is never released, so the stored workflow is left running with that failure memoized.
        bureauA = await createBureau({
          agents: {},
          ...options,
          toolbox: createToolbox<readonly Tool[]>([noopTool]),
          storage: crashed.storage,
          durableExecution: true,
          durableOwnership: { ownership: 'none' },
        });
        const run = await bureauA.createRun({ message: 'Go.' });
        await crashed.reached;
        replayed = holdFirstTerminalRunCommit(
          await resolveStorage({ type: 'sqlite', path: databasePath }),
        );

        // Bureau B is a separate bureau over the same file. Replaying the memoized steps settles
        // the run without calling `generate` or announcing any step. Its terminal commit is held
        // so this test subscribes before the replay can settle.
        let generateCallsAfterRestart = 0;
        const reattached = await createBureau({
          agents: {},
          ...options,
          generate: async (generateInput) => {
            generateCallsAfterRestart += 1;
            return options.generate(generateInput);
          },
          toolbox: createToolbox<readonly Tool[]>([noopTool]),
          storage: replayed.storage,
          durableExecution: true,
          durableOwnership: { ownership: 'none' },
        });
        bureauB = reattached;
        const frames: RunFrame[] = [];
        reattached.subscribeLiveFrames((frame) => {
          if (frame.type === 'run-envelope' && frame.runId === run.id) frames.push(frame.frame);
        });
        await replayed.reached;
        replayed.release();
        await waitForCondition(async () => {
          const session = await reattached.getSession(run.sessionId);
          return session?.metadata['lastRunStatus'] !== 'running';
        }, 'the reattached run never settled');

        // The replay is the whole point: no model call and no step frame, so nothing but the
        // terminal result is left to say where the run stopped.
        expect(generateCallsAfterRestart).toBe(0);
        expect(frames.filter((frame) => frame.type === 'step')).toEqual([]);
        const notifications = budgetNotifications(frames);
        expect(notifications).toHaveLength(1);
        const notification = notifications[0]!;
        expect(notification.code).toBe('budget.exceeded');
        expect(notification.step).toBeUndefined();
        expect(frames[frames.indexOf(notification) + 1]?.type).toBe('run-finished');
      } finally {
        await bureauB?.dispose();
        // Disposed before any release: bureau A's held commit stays pending, as a dead
        // process's would. Releasing it first lets A finish its run mid-dispose.
        await bureauA?.dispose();
        crashed.storage[Symbol.dispose]();
        replayed?.storage[Symbol.dispose]();
        await rm(databasePath, { force: true });
        await rm(`${databasePath}-wal`, { force: true });
        await rm(`${databasePath}-shm`, { force: true });
      }
      // Bureau never closes a storage instance it was handed, so each handle this test opened
      // against the database is the test's to release.
      expect(crashed.disposals()).toBe(1);
      expect(replayed?.disposals()).toBe(1);
    });
  },
);
