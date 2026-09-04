// AB-336 — regression coverage for `requestHumanInput` failing to visibly
// park a `bureau.createRun` session on a fresh (non-recovered) dispatch.
//
// Root cause (named in the pull request body): the durable park mechanism
// itself was already correct — AB-44/AB-45's `stepResult.pendingHumanWait`
// check forces the step loop to break regardless of `stopWhen`, and the
// workflow's own `yield* ctx.waitForSignal(signalName)` genuinely parks. What
// was actually broken (and what AB-270's crash fixture had to work around
// with a bespoke `await-decision` tool) was the run's OBSERVABLE liveness:
// `LivenessSnapshot.status` never left `'running'` for a human-wait park —
// `deriveAssessment`'s `'waiting'` branch was unreachable — so nothing on the
// public liveness surface distinguished a genuinely parked run from one still
// generating. This file proves the park is now observable BEFORE any further
// generation, and that resolving the review resumes with exactly one more
// step, with NO `stopWhen` clause that would mask a loop that doesn't break
// on its own.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';

// Matches `create-bureau.test.ts`'s own identically-named helper: `Toolbox`'s
// generic tool-entries parameter doesn't narrow to an empty array on its
// own, and every human-wait test here needs no domain tools beyond the
// bureau-provided `requestHumanInput`.
function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
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
      expect(detail?.liveness.declaredWait?.reason).toBe('signal');
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
