// COR-121 — a recovered run whose FIRST park is reached during post-recovery
// replay (weft resumes from cached results, so the `requestHumanInput` tool
// never re-executes) must still surface to `listPendingReviews()` and move
// `getRun(runId).liveness` to `'waiting'`.
//
// The crash shape is reproduced in-process with no timers and no subprocess:
// bureau A's storage wrapper swallows the `requestHumanInput` step-record
// write while reporting success, so weft records the `recordStep` activity as
// complete but bureau's own row never lands. Bureau B then recovers the run at
// boot, finds nothing to reconstruct, and replays straight into the wait.

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, HumanWaitParkedEvent, stopWhen } from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError, createBureau } from './create-bureau';
import { waitForCondition } from './test';
import type { Bureau } from './types';

const STEP_KEY_PREFIX = 'durable-run:';
const textDecoder = new TextDecoder();

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

let databaseCounter = 0;
function databasePathFor(label: string): string {
  return join(tmpdir(), `cor121-${label}-${process.pid}-${databaseCounter++}.sqlite`);
}

async function removeDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
}

function isHumanInputStepPut(key: string, value: Uint8Array): boolean {
  return (
    key.startsWith(STEP_KEY_PREFIX) &&
    key.includes(':step:') &&
    textDecoder.decode(value).includes('"toolName":"requestHumanInput"')
  );
}

interface InterceptingStorage {
  storage: Storage;
  matched: () => number;
  disposals: () => number;
  /** Only meaningful in `'hold'` mode: lets the held write proceed. */
  release: () => void;
}

/**
 * Wraps a storage handle. `'drop'` resolves the matching step-record `put`
 * without writing; `'hold'` delays it until `release()` and then writes it.
 * Everything else, including `capabilities()` and disposal, delegates.
 */
function interceptHumanInputStepWrite(inner: Storage, mode: 'drop' | 'hold'): InterceptingStorage {
  let matched = 0;
  let disposals = 0;
  let releaseHeld: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const storage = new Proxy(inner, {
    get(target, property) {
      if (property === 'put') {
        return async (key: string, value: Uint8Array) => {
          if (isHumanInputStepPut(key, value)) {
            matched++;
            if (mode === 'drop') return;
            await released;
          }
          return target.put(key, value);
        };
      }
      if (property === Symbol.dispose) {
        return () => {
          disposals++;
          target[Symbol.dispose]();
        };
      }
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return { storage, matched: () => matched, disposals: () => disposals, release: releaseHeld };
}

async function listStepRecordTexts(storage: Storage, runId: string): Promise<string[]> {
  const texts: string[] = [];
  for await (const [, value] of storage.scan(`${STEP_KEY_PREFIX}${runId}:step:`)) {
    texts.push(textDecoder.decode(value));
  }
  return texts;
}

function parkedEventCount(bureau: Bureau, runId: string): number {
  const run = bureau.getRun(runId);
  return run?.events.filter((event) => event.event === HumanWaitParkedEvent.type).length ?? 0;
}

function reviewsFor(bureau: Bureau, runId: string) {
  return bureau.listPendingReviews().filter((review) => review.runId === runId);
}

async function waitForCompleted(bureau: Bureau, runId: string): Promise<void> {
  await waitForCondition(
    () => bureau.getRun(runId)?.status === 'completed',
    `expected run ${runId} to complete`,
  );
}

const PROMPT = 'Approve the replayed park?';

function humanInputCall(callId: string) {
  return {
    content: '',
    toolCalls: [
      {
        id: callId,
        name: 'requestHumanInput',
        arguments: { signalName: 'human-response', prompt: PROMPT },
      },
    ],
  };
}

describe('a reattached run whose first park happens after boot-time reconstruction (COR-121)', () => {
  it('surfaces the park to listPendingReviews and liveness even though the step row never landed', async () => {
    const databasePath = databasePathFor('crash-shape');
    const wrapped = await resolveStorage({ type: 'sqlite', path: databasePath });
    const intercept = interceptHumanInputStepWrite(wrapped, 'drop');

    let bureauA: Bureau | undefined;
    let bureauB: Bureau | undefined;
    let verificationStorage: Storage | undefined;
    let verificationDisposals = 0;
    try {
      bureauA = await createBureau({
        agents: {},
        generate: async () => humanInputCall('call-a'),
        toolbox: createEmptyToolbox(),
        storage: intercept.storage,
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        humanInput: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      const run = await bureauA.createRun({ message: 'park-me' });
      const runId = run.id;
      await waitForCondition(
        () => reviewsFor(bureauA!, runId).length === 1,
        'expected bureau A to park on requestHumanInput',
      );

      // Preconditions: the crash shape actually holds.
      expect(intercept.matched()).toBe(1);
      const inspector = await resolveStorage({ type: 'sqlite', path: databasePath });
      verificationStorage = new Proxy(inspector, {
        get(target, property) {
          if (property === Symbol.dispose) {
            return () => {
              verificationDisposals++;
              target[Symbol.dispose]();
            };
          }
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
      const persisted = await listStepRecordTexts(verificationStorage, runId);
      expect(persisted.some((text) => text.includes('requestHumanInput'))).toBe(false);

      let bCalls = 0;
      bureauB = await createBureau({
        agents: {},
        generate: async () => {
          bCalls++;
          return { content: 'resumed after recovery', toolCalls: [] };
        },
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        humanInput: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      expect(bCalls).toBe(0);
      const durableRun = await bureauB.getDurableRun(runId);
      expect(durableRun?.status).toBe('running');

      // The fix: the replayed park reaches bureau B's emitter.
      await waitForCondition(
        () => reviewsFor(bureauB!, runId).length === 1,
        'expected bureau B to surface the replayed first park',
      );
      const [review] = reviewsFor(bureauB, runId);
      if (review?.kind !== 'human-wait') throw new Error('expected a human-wait review');
      expect(review.signalName).toBe('human-response');
      expect(review.prompt).toBe(PROMPT);

      await waitForCondition(
        () => bureauB!.getRun(runId)?.liveness.status === 'waiting',
        'expected bureau B liveness to enter waiting',
      );
      const declaredWait = bureauB.getRun(runId)?.liveness.declaredWait;
      expect(declaredWait?.reason).toBe('review');
      expect(declaredWait?.dependency).toBe('human-response');
      expect(parkedEventCount(bureauB, runId)).toBe(1);
      expect(bCalls).toBe(0);
      const durableRunAfter = await bureauB.getDurableRun(runId);
      expect(durableRunAfter?.status).toBe('running');

      const result = await bureauB.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'test-operator',
      });
      expect(result.decision).toBe('approve');
      await waitForCompleted(bureauB, runId);

      expect(bCalls).toBe(1);
      expect(reviewsFor(bureauB, runId)).toHaveLength(0);
      expect(bureauB.getRun(runId)?.liveness.declaredWait).toBeUndefined();
      // Weft re-runs a recovered run's body when the signal is delivered, and
      // the wait is not yet cached at that point, so the marker fires once more
      // just before the wait returns. That is the tolerated duplicate
      // (COR-121): it never re-opens the review (resolved ids stay hidden) and
      // the continuation step ends the announced wait.
      const completedCount = parkedEventCount(bureauB, runId);
      expect(completedCount).toBeGreaterThanOrEqual(1);
      expect(completedCount).toBeLessThanOrEqual(2);
    } finally {
      await bureauB?.dispose();
      await bureauA?.dispose();
      intercept.storage[Symbol.dispose]();
      verificationStorage?.[Symbol.dispose]();
      await removeDatabase(databasePath);
    }
    expect(intercept.disposals()).toBe(1);
    expect(verificationDisposals).toBe(1);
  });

  it('stays silent for a replayed park whose signal was already delivered', async () => {
    const databasePath = databasePathFor('historical');
    let bureauA: Bureau | undefined;
    let bureauB: Bureau | undefined;
    try {
      let aCalls = 0;
      bureauA = await createBureau({
        agents: {},
        generate: async () => {
          aCalls++;
          if (aCalls === 1) return humanInputCall('call-a1');
          if (aCalls === 2) {
            return { content: '', toolCalls: [{ id: 'call-a2', name: 'next', arguments: {} }] };
          }
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        humanInput: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      const run = await bureauA.createRun({ message: 'park-then-continue' });
      const runId = run.id;
      await waitForCondition(
        () => reviewsFor(bureauA!, runId).length === 1,
        'expected bureau A to park',
      );
      const [review] = reviewsFor(bureauA, runId);
      if (review === undefined) throw new Error('expected a review');
      await bureauA.resolveReview({ id: review.id, decision: 'approve', principal: 'test' });
      await waitForCondition(
        () => aCalls === 3,
        'expected bureau A to commit the next step and hang on the third generate',
      );

      let bCalls = 0;
      bureauB = await createBureau({
        agents: {},
        generate: async () => {
          bCalls++;
          return { content: 'done after recovery', toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        humanInput: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      await waitForCompleted(bureauB, runId);

      expect(bCalls).toBe(1);
      expect(parkedEventCount(bureauB, runId)).toBe(0);
      expect(bureauB.listPendingReviews()).toHaveLength(0);
      expect(bureauB.getRun(runId)?.liveness.declaredWait).toBeUndefined();
    } finally {
      await bureauB?.dispose();
      await bureauA?.dispose();
      await removeDatabase(databasePath);
    }
  });
});

describe('bounded duplicate park events (COR-121)', () => {
  it('a fresh run keeps exactly the tool dispatch', async () => {
    let calls = 0;
    const bureau = await createBureau({
      agents: {},
      generate: async () => {
        calls++;
        return calls === 1
          ? humanInputCall('call-1')
          : { content: 'approved and done', toolCalls: [] };
      },
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'park-me' });
      await waitForCondition(
        () => reviewsFor(bureau, run.id).length === 1,
        'expected the fresh run to park',
      );
      expect(bureau.listPendingReviews()).toHaveLength(1);
      const [review] = reviewsFor(bureau, run.id);
      if (review === undefined) throw new Error('expected a review');
      await bureau.resolveReview({ id: review.id, decision: 'approve', principal: 'test' });
      await waitForCompleted(bureau, run.id);
      expect(parkedEventCount(bureau, run.id)).toBe(1);
    } finally {
      await bureau.dispose();
    }
  });

  it('a boot-found park adds a bounded number of markers on top of the boot record', async () => {
    const databasePath = databasePathFor('boot-found');
    let bureauA: Bureau | undefined;
    let bureauB: Bureau | undefined;
    try {
      bureauA = await createBureau({
        agents: {},
        generate: async () => humanInputCall('call-a'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        humanInput: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      const run = await bureauA.createRun({ message: 'park-me' });
      await waitForCondition(
        () => reviewsFor(bureauA!, run.id).length === 1,
        'expected bureau A to park',
      );

      let bCalls = 0;
      bureauB = await createBureau({
        agents: {},
        generate: async () => {
          bCalls++;
          return { content: 'resumed', toolCalls: [] };
        },
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        humanInput: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      await waitForCondition(
        () => reviewsFor(bureauB!, run.id).length === 1,
        'expected bureau B to surface the park',
      );
      expect(bureauB.listPendingReviews()).toHaveLength(1);
      const [review] = reviewsFor(bureauB, run.id);
      if (review === undefined) throw new Error('expected a review');
      await bureauB.resolveReview({ id: review.id, decision: 'approve', principal: 'test' });
      await waitForCompleted(bureauB, run.id);
      expect(bCalls).toBe(1);
      const count = parkedEventCount(bureauB, run.id);
      expect(count).toBeGreaterThanOrEqual(1);
      // Boot record, the boot-time replay marker, and the signal-delivery
      // replay marker: never once per replay iteration beyond that.
      expect(count).toBeLessThanOrEqual(3);
    } finally {
      await bureauB?.dispose();
      await bureauA?.dispose();
      await removeDatabase(databasePath);
    }
  });
});

describe('flow-control slot accounting under dual dispatch (COR-121 guard)', () => {
  it('a signal delivered while the step write is held does not release the resumed run’s slot', async () => {
    const databasePath = databasePathFor('flow-control');
    const wrapped = await resolveStorage({ type: 'sqlite', path: databasePath });
    const intercept = interceptHumanInputStepWrite(wrapped, 'hold');

    let calls = 0;
    let resolveBlocking: (value: { content: string; toolCalls: [] }) => void = () => {};
    const blocking = new Promise<{ content: string; toolCalls: [] }>((resolve) => {
      resolveBlocking = resolve;
    });
    const generate: GenerateFunction = async () => {
      calls++;
      if (calls === 1) return humanInputCall('call-1');
      return blocking;
    };

    let bureau: Bureau | undefined;
    try {
      bureau = await createBureau({
        agents: {},
        generate,
        toolbox: createEmptyToolbox(),
        storage: intercept.storage,
        durableExecution: true,
        humanInput: true,
        flowControl: { concurrency: { limit: 1 } },
        stopWhen: stopWhen.noToolCalls(),
      });
      const runOne = await bureau.createRun({ message: 'park-me' });
      await waitForCondition(
        () => reviewsFor(bureau!, runOne.id).length === 1,
        'expected run one to park',
      );
      expect(intercept.matched()).toBe(1);

      await bureau.signalSession(runOne.sessionId, 'human-response', { approved: true });
      intercept.release();
      await waitForCondition(() => calls === 2, 'expected the continuation generate to start');

      const rejected = await bureau.createRun({ message: 'second' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejected).toBeInstanceOf(BureauError);
      expect((rejected as BureauError).code).toBe('RATE_LIMITED');
      expect(parkedEventCount(bureau, runOne.id)).toBe(1);

      resolveBlocking({ content: 'done', toolCalls: [] });
      await waitForCompleted(bureau, runOne.id);
      expect(bureau.getRun(runOne.id)?.status).toBe('completed');
      expect(parkedEventCount(bureau, runOne.id)).toBe(1);
      expect(bureau.listPendingReviews()).toHaveLength(0);
      expect(bureau.getRun(runOne.id)?.liveness.declaredWait).toBeUndefined();
    } finally {
      intercept.release();
      await bureau?.dispose();
      intercept.storage[Symbol.dispose]();
      await removeDatabase(databasePath);
    }
    expect(intercept.disposals()).toBe(1);
  });
});
