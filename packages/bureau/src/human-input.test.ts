// AB-336 — regression coverage for `requestHumanInput` failing to visibly
// park a `bureau.createRun` session, on both a fresh dispatch and a
// recovered one.
//
// Two independent, previously-broken mechanisms this file proves fixed:
//
// - On a FRESH dispatch, the durable park itself was already correct —
//   AB-44/AB-45's `stepResult.pendingHumanWait` check forces the step loop
//   to break regardless of `stopWhen`, and the workflow's own
//   `yield* ctx.waitForSignal(signalName)` genuinely parks. What was
//   actually broken was the run's OBSERVABLE liveness:
//   `LivenessSnapshot.status` never left `'running'` for a human-wait park
//   — `deriveAssessment`'s `'waiting'` branch was unreachable.
// - On a RECOVERED dispatch — the case AB-270's crash fixture actually
//   exercises — the bug was upstream of observability: `buildRunDepsFromSession`
//   (the recovery-path toolbox reconstruction in `runtime-composition.ts`)
//   never wired `requestHumanInput` into a recovered run's toolbox at all.
//   A run recovered mid-step whose replay called `requestHumanInput` found
//   no such tool, `pendingHumanWait` never got set, and the step loop simply
//   continued to the next step — the "looped instead of parking" symptom
//   AB-336 names, reproduced by this file's own recovery test below BEFORE
//   the fix and green after it. A run recovered AFTER the park's own step
//   already committed hits a third, narrower gap — bureau's own
//   `listPendingReviews()` never reconstructed the pending review from a
//   dead process's lost in-memory action log — covered separately.
//
// Every test here deliberately omits `stopWhen.toolCalled('requestHumanInput')`
// (every pre-existing park test in `create-bureau.test.ts` uses it), so a
// loop that doesn't break on its own is never masked.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, HumanWaitParkedEvent, stopWhen } from '@lostgradient/operative';
import {
  createProcessLocalGrantStateStore,
  createTool,
  createToolbox,
  type Toolbox,
} from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';

const runtime = createDefaultRuntimeServices();

/** How long a negative assertion waits for a replayed park marker that never should arrive. */
const REPLAY_SETTLE_WINDOW_MS = 150;

function settleReplayWindow(): Promise<void> {
  return new Promise<void>((resolve) =>
    runtime.timers.setTimeout(resolve, REPLAY_SETTLE_WINDOW_MS),
  );
}

// Matches `create-bureau.test.ts`'s own identically-named helper: `Toolbox`'s
// generic tool-entries parameter doesn't narrow to an empty array on its
// own, and every human-wait test here needs no domain tools beyond the
// bureau-provided `requestHumanInput`.
function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

/** A trivial tool that keeps a step loop going without ever parking. */
function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

let recoveryDatabaseCounter = 0;

describe('requestHumanInput park is observable on a fresh dispatch (AB-336)', () => {
  it('parks before any further generation, observable through listPendingReviews, getRun, getDurableRun, and liveness', async () => {
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls++;
      return {
        content: '',
        toolCalls: [
          {
            id: `call-${calls}`,
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Approve this?' },
          },
        ],
      };
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      // Deliberately NOT `stopWhen.toolCalled('requestHumanInput')` — every
      // pre-existing test in create-bureau.test.ts uses that condition,
      // which would stop the step loop on its own and mask whether the
      // durable park itself forces the break. `noToolCalls()` never matches
      // this generate function (it always calls a tool), so the ONLY thing
      // that can end this run's step loop is the `pendingHumanWait` break.
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureau.createRun({ message: 'park-me' });

      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === run.id),
        'expected requestHumanInput to park and surface a pending review',
      );

      // Exactly one generation step ran before the park — the loop broke on
      // its own, with no `stopWhen` clause doing that work for it.
      expect(calls).toBe(1);

      // Durable-run surface: the review is present and correctly shaped.
      const reviews = bureau.listPendingReviews();
      expect(reviews).toHaveLength(1);
      const [review] = reviews;
      expect(review?.kind).toBe('human-wait');
      if (review?.kind !== 'human-wait') throw new Error('unreachable');
      expect(review.runId).toBe(run.id);
      expect(review.signalName).toBe('human-response');
      expect(review.prompt).toBe('Approve this?');

      // Durable-run surface: the engine genuinely still owns this run (not
      // terminal) — `getDurableRun` is Weft's own status, distinct from
      // bureau's `status: 'running'` bookkeeping.
      const durableRun = await bureau.getDurableRun(run.id);
      expect(durableRun?.status).toBe('running');

      // Public liveness surface (AB-88/AB-214): this is the actual gap
      // AB-336 closes. Before this fix, `status` stayed `'running'` and
      // `assessment` stayed `'healthy'` for a genuinely parked run.
      const detail = bureau.getRun(run.id);
      expect(detail?.liveness.status).toBe('waiting');
      expect(detail?.liveness.assessment).toBe('legitimately-waiting');
      expect(detail?.liveness.declaredWait).toBeDefined();
      // AB-88: a supplied `prompt` (this run's `requestHumanInput` call
      // includes one) makes the reason 'review', not 'signal' — matching
      // `SessionHandle`'s identical derivation at its own observation layer.
      expect(detail?.liveness.declaredWait?.reason).toBe('review');
      expect(detail?.liveness.declaredWait?.dependency).toBe('human-response');

      // No further generation happened while parked.
      expect(calls).toBe(1);
    } finally {
      bureau.dispose();
    }
  });

  it('resumes with exactly one more step once the review is resolved, and liveness leaves the wait', async () => {
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls++;
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response' },
            },
          ],
        };
      }
      return { content: 'approved and processed', toolCalls: [] };
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      // `toolCalled` stops the FIRST step right on the park request (so the
      // post-loop park check sees `pendingHumanWait`); `noToolCalls` stops
      // the CONTINUATION step once it settles on plain content — matching
      // this test's own `generate`, which never calls a tool after step 1.
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });

    try {
      const run = await bureau.createRun({ message: 'park-me' });

      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === run.id),
        'expected requestHumanInput to park and surface a pending review',
      );
      expect(calls).toBe(1);
      expect(bureau.getRun(run.id)?.liveness.status).toBe('waiting');

      const [review] = bureau.listPendingReviews();
      const result = await bureau.resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'test-operator',
      });
      expect(result.decision).toBe('approve');

      await waitForCondition(
        () => calls === 2,
        'expected the resumed run to take exactly one more generation step',
      );

      // No third step: this generate function returns no tool calls on its
      // second call, so a run that kept generating past resumption would
      // still be caught here.
      const finalRun = bureau.getRun(run.id);
      expect(finalRun?.status).toBe('completed');
      expect(calls).toBe(2);

      // Liveness left the declared wait once the run resumed and settled.
      expect(finalRun?.liveness.status).toBe('terminal');
      expect(finalRun?.liveness.declaredWait).toBeUndefined();

      expect(bureau.listPendingReviews()).toHaveLength(0);
    } finally {
      bureau.dispose();
    }
  });
});

describe('requestHumanInput park survives a process restart while still parked (AB-336)', () => {
  it('listPendingReviews reconstructs the pending human-wait review after recovery, and resolving it resumes the run', async () => {
    // THE CROSS-PROCESS PROOF, mirroring the existing durable-recovery tests
    // in create-bureau.test.ts: two bureaus share one persistent SQLite
    // backend the way two processes would (this is AB-270's crash fixture's
    // own backend). Bureau A parks on `requestHumanInput` and is never
    // disposed — simulating a crash while genuinely parked, the exact
    // scenario the crash fixture's `signal-parked` marker now drives through
    // the real tool instead of a bespoke stand-in.
    const databasePath = join(
      tmpdir(),
      `ab336-human-wait-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    let aCalls = 0;
    const bureauA = await createBureau({
      agents: {},
      generate: async () => {
        aCalls++;
        return {
          content: '',
          toolCalls: [
            {
              id: `call-${aCalls}`,
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response' },
            },
          ],
        };
      },
      toolbox: createEmptyToolbox(),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureauA.createRun({ message: 'park-me' });
    await waitForCondition(
      () => bureauA.listPendingReviews().some((review) => review.runId === run.id),
      'expected bureau A to park on requestHumanInput before the simulated crash',
    );
    expect(aCalls).toBe(1);
    // Deliberately NOT disposing bureauA — this IS the crash: bureau A's
    // durable engine, and the live `HumanWaitParkedEvent` action it recorded
    // in its own in-memory action log, are both abandoned.

    let bCalls = 0;
    const bureauB = await createBureau({
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

    try {
      // Root cause this proves fixed: `listPendingReviews()`'s human-wait
      // branch derived entirely from the live action log, which a
      // freshly `store.register`ed recovered run starts EMPTY — nothing
      // replayed the park bureau A's dead process recorded. Without the
      // checkpoint-reconstruction fix, this would time out.
      await waitForCondition(
        () => bureauB.listPendingReviews().some((review) => review.runId === run.id),
        'expected bureau B to reconstruct the pending human-wait review after recovery',
      );

      const reviews = bureauB.listPendingReviews();
      expect(reviews).toHaveLength(1);
      const [review] = reviews;
      expect(review?.kind).toBe('human-wait');
      if (review?.kind !== 'human-wait') throw new Error('unreachable');
      expect(review.runId).toBe(run.id);
      expect(review.signalName).toBe('human-response');

      // No generation happened on bureau B before the review is resolved —
      // the recovered run is genuinely still parked, not looping.
      expect(bCalls).toBe(0);

      const result = await bureauB.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'test-operator',
      });
      expect(result.decision).toBe('approve');

      await waitForCondition(
        () => bCalls === 1,
        'expected resolving the recovered review to resume the run with exactly one more step',
      );
      expect(bCalls).toBe(1);

      const finalRun = bureauB.getRun(run.id);
      expect(finalRun?.status).toBe('completed');
      expect(bureauB.listPendingReviews()).toHaveLength(0);
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });
});

describe('a resolved human-wait review stays resolved across a restart (COR-106)', () => {
  it('does not resurface a park whose resolved id was persisted before the crash', async () => {
    // resolveReview delivered the signal and persisted the park's id, then the
    // process died before the run committed a step past the park. On recovery
    // the last checkpointed step is still the park, so it is re-synthesized;
    // its id must equal the persisted one or it would show as pending again.
    const databasePath = join(
      tmpdir(),
      `cor106-human-wait-resolved-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    let aCalls = 0;
    const bureauA = await createBureau({
      agents: {},
      generate: async () => {
        aCalls++;
        if (aCalls > 1) return new Promise<never>(() => {}); // the crash
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response' },
            },
          ],
        };
      },
      toolbox: createEmptyToolbox(),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureauA.createRun({ message: 'park-me' });
    await waitForCondition(
      () => bureauA.listPendingReviews().some((review) => review.runId === run.id),
      'expected bureau A to park on requestHumanInput before the simulated crash',
    );
    const parkedId = bureauA.listPendingReviews()[0]!.id;
    // The real delivery: the signal reaches the engine, so the resumed run
    // moves on to its next (never-completing) step.
    await bureauA.signalSession(run.sessionId, 'human-response');
    await waitForCondition(() => aCalls === 2, 'expected bureau A to resume past the park');
    await bureauA.sessionStore!.update(run.sessionId, (session) => ({
      ...session!,
      metadata: { ...session!.metadata, resolvedReviewIds: [parkedId] },
    }));
    // Not disposing bureauA: this is the crash.

    const bureauB = await createBureau({
      agents: {},
      generate: async () => ({ content: 'resumed', toolCalls: [] }),
      toolbox: createEmptyToolbox(),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      // The park must have been reconstructed into the live action log.
      await waitForCondition(
        () =>
          bureauB.store
            .getRun(run.id)
            ?.actions.some((action) => action.type === HumanWaitParkedEvent.type) === true,
        'expected bureau B to reconstruct the park action',
      );
      expect(bureauB.listPendingReviews()).toHaveLength(0);

      // Settle the recovered run before disposing, or its aborted-state write
      // lands after the SQLite handle is finalized.
      await waitForCondition(
        () => bureauB.getRun(run.id)?.status === 'completed',
        'expected bureau B to finish the recovered run before disposal',
      );
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });

  it('numbers a re-park after several resolved parks and a mid-step crash past all of them', async () => {
    const databasePath = join(
      tmpdir(),
      `cor106-human-wait-multi-park-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    let aCalls = 0;
    const bureauA = await createBureau({
      agents: {},
      generate: async () => {
        aCalls++;
        if (aCalls <= 2) {
          return {
            content: '',
            toolCalls: [
              {
                id: `call-${aCalls}`,
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response' },
              },
            ],
          };
        }
        if (aCalls === 3) return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
        return new Promise<never>(() => {}); // the crash
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureauA.createRun({ message: 'park-twice-then-crash' });
    const resolvedIds: string[] = [];
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      await waitForCondition(
        () =>
          bureauA
            .listPendingReviews()
            .some((review) => review.runId === run.id && !resolvedIds.includes(review.id)),
        `expected bureau A to park (${ordinal})`,
      );
      const pending = bureauA
        .listPendingReviews()
        .find((review) => review.runId === run.id && !resolvedIds.includes(review.id))!;
      expect(pending.id.endsWith(`:human-response:${ordinal}`)).toBe(true);
      await bureauA.resolveReview({ id: pending.id, decision: 'approve', principal: 'op' });
      resolvedIds.push(pending.id);
    }
    await waitForCondition(() => aCalls === 4, 'expected bureau A to reach the hanging step');
    // Not disposing bureauA: this is the crash.

    let bCalls = 0;
    const bureauB = await createBureau({
      agents: {},
      generate: async () => {
        bCalls++;
        if (bCalls === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-b',
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response' },
              },
            ],
          };
        }
        return { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      await waitForCondition(
        () => bureauB.listPendingReviews().some((review) => review.runId === run.id),
        'expected the re-park after recovery to surface as a pending review',
      );
      expect(bureauB.getRun(run.id)?.liveness.status).toBe('waiting');
      const reviews = bureauB.listPendingReviews();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.id.endsWith(':human-response:2')).toBe(true);
      expect(resolvedIds).not.toContain(reviews[0]!.id);

      await bureauB.resolveReview({ id: reviews[0]!.id, decision: 'approve', principal: 'op' });
      await waitForCondition(
        () => bureauB.getRun(run.id)?.status === 'completed',
        'expected bureau B to finish the recovered run before disposal',
      );
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });
});

describe('a re-park after a resolved park and a crash before the next commit (COR-106)', () => {
  it('surfaces the re-park on the same signal instead of hiding it behind the resolved id', async () => {
    const databasePath = join(
      tmpdir(),
      `cor106-human-wait-resume-crash-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    let aCalls = 0;
    const bureauA = await createBureau({
      agents: {},
      generate: async () => {
        aCalls++;
        if (aCalls === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response' },
              },
            ],
          };
        }
        return new Promise<never>(() => {}); // the crash, before the next step commits
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureauA.createRun({ message: 'park-resume-crash' });
    await waitForCondition(
      () => bureauA.listPendingReviews().some((review) => review.runId === run.id),
      'expected bureau A to park',
    );
    const first = bureauA.listPendingReviews()[0]!;
    expect(first.id.endsWith(':human-response:0')).toBe(true);
    await bureauA.resolveReview({ id: first.id, decision: 'approve', principal: 'op' });
    await waitForCondition(() => aCalls === 2, 'expected bureau A to resume into the hanging step');
    // Not disposing bureauA: this is the crash.

    let bCalls = 0;
    const bureauB = await createBureau({
      agents: {},
      generate: async () => {
        bCalls++;
        if (bCalls === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-b',
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response' },
              },
            ],
          };
        }
        return { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      await waitForCondition(
        () => bureauB.listPendingReviews().some((review) => review.runId === run.id),
        'expected the re-park after recovery to surface as a pending review',
      );
      expect(bureauB.getRun(run.id)?.liveness.status).toBe('waiting');
      const reviews = bureauB.listPendingReviews();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.id.endsWith(':human-response:1')).toBe(true);
      expect(reviews[0]!.id).not.toBe(first.id);

      await bureauB.resolveReview({ id: reviews[0]!.id, decision: 'approve', principal: 'op' });
      await waitForCondition(
        () => bureauB.getRun(run.id)?.status === 'completed',
        'expected bureau B to finish the recovered run before disposal',
      );
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });
});

describe('resolving a recovered run re-park leaves no phantom review (COR-106)', () => {
  it('keeps listPendingReviews empty while the resumed run is still running its next step', async () => {
    const databasePath = join(
      tmpdir(),
      `cor106-human-wait-phantom-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const park = (id: string) => ({
      content: '',
      toolCalls: [{ id, name: 'requestHumanInput', arguments: { signalName: 'human-response' } }],
    });
    const options = (generate: () => Promise<ReturnType<typeof park>>) => ({
      agents: {},
      generate,
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite' as const, path: databasePath },
      durableExecution: true as const,
      durableOwnership: { ownership: 'none' as const },
      humanInput: true as const,
      stopWhen: stopWhen.noToolCalls(),
    });

    const bureauA = await createBureau(options(async () => park('call-a')));
    const run = await bureauA.createRun({ message: 'park-crash-repark-resolve' });
    await waitForCondition(
      () => bureauA.listPendingReviews().some((review) => review.runId === run.id),
      'expected bureau A to park',
    );
    // Not disposing bureauA: this is the crash.

    let bCalls = 0;
    let releaseNextStep: () => void = () => {};
    const nextStepGate = new Promise<void>((resolve) => {
      releaseNextStep = resolve;
    });
    const bureauB = await createBureau(
      options(async () => {
        bCalls++;
        if (bCalls === 1) return park('call-b');
        await nextStepGate; // the resumed run stays mid-step
        return { content: 'done', toolCalls: [] };
      }),
    );
    const pendingIds = (): string[] =>
      bureauB
        .listPendingReviews()
        .filter((review) => review.runId === run.id)
        .map((review) => review.id);

    try {
      await waitForCondition(() => pendingIds().length === 1, 'expected the reconstructed park');
      const reconstructed = pendingIds()[0]!;
      expect(reconstructed.endsWith(':human-response:0')).toBe(true);
      await bureauB.resolveReview({ id: reconstructed, decision: 'approve', principal: 'op' });
      await waitForCondition(
        () => pendingIds().length === 1 && pendingIds()[0] !== reconstructed,
        'expected the re-park to surface',
      );
      const repark = pendingIds()[0]!;
      expect(repark.endsWith(':human-response:1')).toBe(true);
      await bureauB.resolveReview({ id: repark, decision: 'approve', principal: 'op' });
      await waitForCondition(() => bCalls >= 2, 'expected the run to resume into its next step');
      // Let any replayed park marker land before asserting: a bounded real
      // window, observed through the runtime timers, because SQLite replay can
      // take more than one event-loop turn.
      await settleReplayWindow();
      expect(bureauB.getRun(run.id)?.status).toBe('running');
      expect(pendingIds()).toEqual([]);
    } finally {
      releaseNextStep();
      await waitForCondition(
        () => bureauB.getRun(run.id)?.status === 'completed',
        'expected bureau B to finish the recovered run before disposal',
      );
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });
});

describe('parallel same-signal parks keep review ids stable across a restart (COR-106)', () => {
  it('reconstructs no phantom review after two parallel same-signal calls, a re-park, and a crash', async () => {
    const databasePath = join(
      tmpdir(),
      `cor106-parallel-park-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const call = (id: string) => ({
      id,
      name: 'requestHumanInput',
      arguments: { signalName: 'human-response' },
    });
    let aCalls = 0;
    const bureauA = await createBureau({
      agents: {},
      generate: async () => {
        aCalls++;
        if (aCalls === 1) return { content: '', toolCalls: [call('a1'), call('a2')] };
        if (aCalls === 2) return { content: '', toolCalls: [call('a3')] };
        return new Promise<never>(() => {}); // step 3 hangs: the crash
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    const run = await bureauA.createRun({ message: 'parallel-park-crash' });
    const pendingA = (): string[] =>
      bureauA
        .listPendingReviews()
        .filter((review) => review.runId === run.id)
        .map((review) => review.id);
    await waitForCondition(() => pendingA().length === 1, 'expected the first park');
    const first = pendingA()[0]!;
    expect(first.endsWith(':human-response:0')).toBe(true);
    await bureauA.resolveReview({ id: first, decision: 'approve', principal: 'op' });
    await waitForCondition(
      () => pendingA().length === 1 && pendingA()[0] !== first,
      'expected the re-park to surface',
    );
    const second = pendingA()[0]!;
    expect(second.endsWith(':human-response:1')).toBe(true);
    await bureauA.resolveReview({ id: second, decision: 'approve', principal: 'op' });
    await waitForCondition(() => aCalls >= 3, 'expected the run to resume into step 3');
    // Not disposing bureauA: this is the crash.

    let bCalls = 0;
    let releaseNextStep: () => void = () => {};
    const nextStepGate = new Promise<void>((resolve) => {
      releaseNextStep = resolve;
    });
    const bureauB = await createBureau({
      agents: {},
      generate: async () => {
        bCalls++;
        await nextStepGate;
        return { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      await waitForCondition(() => bCalls >= 1, 'expected the recovered run to reach step 3');
      // Let any replayed park marker land before asserting: a bounded real
      // window, observed through the runtime timers, because SQLite replay can
      // take more than one event-loop turn.
      await settleReplayWindow();
      expect(bureauB.getRun(run.id)?.status).toBe('running');
      expect(bureauB.listPendingReviews().filter((review) => review.runId === run.id)).toEqual([]);
    } finally {
      releaseNextStep();
      await waitForCondition(
        () => bureauB.getRun(run.id)?.status === 'completed',
        'expected bureau B to finish the recovered run before disposal',
      );
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });
});

describe('a run recovered mid-step whose replay reaches requestHumanInput actually parks (AB-336)', () => {
  it('does not loop past requestHumanInput on a recovered dispatch — the recovery-path toolbox reconstruction wires it in', async () => {
    // THE ROOT-CAUSE PROOF: unlike the other recovery test above (which
    // crashes AFTER the requestHumanInput step already committed, and so
    // never actually replays the tool call), this crashes DURING the
    // PRECEDING step — bureau B's replay must call `generate` fresh for the
    // requestHumanInput step, going through `buildRunDepsFromSession`'s
    // toolbox reconstruction. Before AB-336's fix, that reconstruction
    // never included `requestHumanInput`: the call would settle as a
    // tool-not-found error, `pendingHumanWait` would never be set, and the
    // step loop would continue straight past the park.
    const databasePath = join(
      tmpdir(),
      `ab336-toolbox-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    let bureauAReachedStep1 = false;
    const bureauA = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        if (step === 0) {
          return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        bureauAReachedStep1 = true; // step 0's checkpoint has committed
        // Hang forever — the "process" dies here, before step 1's own
        // generate call (the requestHumanInput call) ever resolves.
        return new Promise<never>(() => {});
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureauA.createRun({ message: 'park-me-after-recovery' });
    await waitForCondition(
      () => bureauAReachedStep1,
      'expected bureau A to reach step 1 before the simulated crash',
    );
    // Deliberately NOT disposing bureauA — simulates a crash: the durable
    // workflow is left non-terminal, parked mid-step-1's (never-resolving)
    // generate call, for bureau B's recoverAll() to pick up.

    let bCalls = 0;
    const bureauB = await createBureau({
      agents: {},
      generate: async () => {
        bCalls++;
        if (bCalls === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response' },
              },
            ],
          };
        }
        return { content: 'resumed after recovery', toolCalls: [] };
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      await waitForCondition(
        () => bureauB.listPendingReviews().some((review) => review.runId === run.id),
        'expected bureau B to actually park on requestHumanInput during replay, not loop past it',
      );

      // The load-bearing assertion: exactly ONE generate call happened on
      // bureau B before the park — a run that looped past a missing tool
      // would show 2+ (it would keep calling generate with no tool call
      // ever setting pendingHumanWait, running to noToolCalls()'s own stop
      // or maximumSteps).
      expect(bCalls).toBe(1);

      const reviews = bureauB.listPendingReviews();
      expect(reviews).toHaveLength(1);
      const [review] = reviews;
      expect(review?.kind).toBe('human-wait');
      if (review?.kind !== 'human-wait') throw new Error('unreachable');
      expect(review.runId).toBe(run.id);
      expect(review.signalName).toBe('human-response');
      expect(bureauB.getRun(run.id)?.liveness.status).toBe('waiting');

      const result = await bureauB.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'test-operator',
      });
      expect(result.decision).toBe('approve');

      await waitForCondition(
        () => bCalls === 2,
        'expected resolving the review to resume the run with exactly one more step',
      );
      expect(bCalls).toBe(2);

      const finalRun = bureauB.getRun(run.id);
      expect(finalRun?.status).toBe('completed');
      expect(bureauB.listPendingReviews()).toHaveLength(0);
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });
});

// AB-362 — regression coverage for `combineToolboxes` dropping the base
// toolbox's `policy`, `approvalSecret`, `approvalStateStore`, and
// `grantStateStore` when `wireDurableOptInTools` grafts the durable
// `requestHumanInput`/`scheduleWakeup` tools onto a run's toolbox (AB-336).
// Before the fix, a run opting into `humanInput: true` alongside a
// `needs_approval`-gated tool skipped capability-approval AND
// reusable-grant matching entirely: the tool executed immediately, no
// pending review was ever created, and a matching grant never got the
// chance to short-circuit anything because there was nothing to
// short-circuit. These two tests exercise the fix through Bureau's public
// surface exactly as a durable `humanInput` run would.
describe("combineToolboxes forwards the base toolbox's approval gating to a humanInput run (AB-362)", () => {
  /**
   * Grant matching (AB-46, AB-346) is wired inside armorer's `mergePolicies`
   * `approvalPolicy` branch, ahead of `evaluateCapabilityApproval`'s `ask`
   * outcome — so, unlike some of this file's other fixtures, this one uses
   * `approvalPolicy: { mode: 'always' }` rather than a bespoke
   * `policy.beforeExecute` hook, so a call actually reaches the
   * grant-matching check once combined with the humanInput toolbox.
   */
  function createGrantMatchableToolbox(
    approvalSecret: string,
    charges: number[],
    grantStateStore?: ReturnType<typeof createProcessLocalGrantStateStore>,
  ): Toolbox {
    return createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            charges.push(cents);
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret,
        approvalPolicy: { mode: 'always' },
        ...(grantStateStore ? { grantStateStore } : {}),
      },
    ) as unknown as Toolbox;
  }

  function createChargeGenerate(): GenerateFunction {
    let calls = 0;
    return async () => {
      calls += 1;
      return calls === 1
        ? {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 4200 } }],
          }
        : { content: 'ok', toolCalls: [] };
    };
  }

  it('a needs_approval tool call on a humanInput run produces a pending review and does not execute', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createChargeGenerate(),
      toolbox: createGrantMatchableToolbox('humaninput-no-grant-secret', charges),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.toolOutcome('action_required'),
    });

    try {
      const run = await bureau.createRun({ message: 'Charge the customer' });

      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === run.id),
        'expected the needs_approval tool call to produce a pending review',
      );

      expect(charges).toEqual([]);
      const reviews = bureau.listPendingReviews();
      expect(reviews).toHaveLength(1);
      const [review] = reviews;
      expect(review?.kind).toBe('tool-approval');
      if (review?.kind !== 'tool-approval') throw new Error('unreachable');
      expect(review.approval.toolName).toBe('charge-card');

      // Approving resumes the call — proving the review this run produced
      // was a genuine, resumable armorer approval, not a coincidental stall.
      const result = await bureau.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'test-operator',
      });
      expect(result.decision).toBe('approve');
      expect(charges).toEqual([4200]);
    } finally {
      bureau.dispose();
    }
  });

  it('a matching reusable grant short-circuits the needs_approval policy on a humanInput run, consuming the grant', async () => {
    const charges: number[] = [];
    const approvalSecret = 'humaninput-grant-match-secret';
    const grantStateStore = createProcessLocalGrantStateStore();
    const decrementCalls: string[] = [];
    const observedGrantStateStore: typeof grantStateStore = {
      ...grantStateStore,
      decrementUse: async (id: string) => {
        decrementCalls.push(id);
        return grantStateStore.decrementUse(id);
      },
    };

    const bureau = await createBureau({
      agents: {},
      generate: createChargeGenerate(),
      toolbox: createGrantMatchableToolbox(approvalSecret, charges, observedGrantStateStore),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.toolOutcome('action_required'),
    });

    try {
      const principal = 'humaninput-grant-principal';
      const grant = await bureau.issueGrant({
        principalId: principal,
        tenantId: 'bureau',
        ownerId: 'bureau',
        agentId: 'bureau',
        toolName: 'charge-card',
        scope: 'principal',
        expiresAt: Number.MAX_SAFE_INTEGER,
        maxUses: 1,
        delegationBehavior: 'does-not-propagate',
      });

      const run = await bureau.createRun({ message: 'Charge the customer', principal });

      await waitForCondition(() => charges.length > 0, 'expected the tool call to execute');

      expect(charges).toEqual([4200]);
      expect(bureau.listPendingReviews().filter((review) => review.runId === run.id)).toHaveLength(
        0,
      );
      // Proof the grant was actually consumed by the combined toolbox
      // (armorer's own `grant.used` toolbox event, which bureau does not
      // forward): the SAME grantStateStore reference `combineToolboxes`
      // must carry through was decremented.
      expect(decrementCalls).toEqual([grant.id]);
      const [stored] = await grantStateStore.list();
      expect(stored?.usesRemaining).toBe(0);
    } finally {
      bureau.dispose();
    }
  });
});
