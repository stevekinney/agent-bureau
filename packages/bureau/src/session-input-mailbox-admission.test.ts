import type { GenerateFunction, SessionInputAdmissionOutcome } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { Bureau } from './types';

/**
 * COR-435 — mailbox-backed `submitSessionInput` admission, persistence, and
 * promotion outcomes.
 *
 * A new sibling file rather than an addition to `create-bureau.test.ts`
 * (already ~21k lines): this slice's tests are self-contained black-box
 * assertions against `Bureau.submitSessionInput`'s public contract and do
 * not share fixtures with the rest of that file. Keeping them here avoids
 * growing an already-oversized file further while the pre-admission tests
 * for the SAME method (`describe('createBureau submitSessionInput
 * pre-admission checks (AB-194)')`) stay where they are — that block
 * predates this issue and asserts a distinct, still-true contract slice
 * (authorization/lifecycle rejections that hold regardless of whether a
 * mailbox is composed).
 *
 * Written test-first per COR-435's working discipline: every `it` below is
 * expected to fail against pre-COR-435 `create-bureau.ts`, which
 * unconditionally returns `{ outcome: 'unsupported-capability', reason:
 * 'durable-mailbox-unavailable' }` for every authorized, non-terminal
 * request. Confirmed red before implementation begins.
 *
 * Scope note: this file covers acceptance criteria 1-5 (admission/receipt
 * shape, replay, conflict reasons, concurrent in-flight reservation sharing,
 * backlog exhaustion). Criteria 6-7 (the single dedicated `ctx.memo`
 * promotion step and its three crash-window recovery scenarios) need the
 * promotion implementation's own shape decided first and are deliberately
 * left for a follow-up change once this admission slice is reviewed.
 */

function createHungGenerate(): GenerateFunction {
  // Never resolves and never reaches a step boundary, so a session stays
  // 'running' (non-terminal) for the life of the test and nothing gets a
  // chance to promote a submitted session input out of 'accepted'/'queued'.
  return () => new Promise<never>(() => {});
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

async function pollUntil(check: () => boolean | Promise<boolean>, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return true;
    await yieldToPortableEventLoop();
  }
  return check();
}

async function createRunningBureauSession(bureau: Bureau, principal = 'alice'): Promise<string> {
  const run = await bureau.createRun({ message: 'hold open', principal });
  await pollUntil(async () => {
    const session = await bureau.getSession(run.sessionId);
    return session?.metadata['lastRunStatus'] === 'running';
  });
  return run.sessionId;
}

async function createDurableBureauWithRunningSession(
  overrides: Partial<Parameters<typeof createBureau>[0]> = {},
): Promise<{ bureau: Bureau; sessionId: string }> {
  const bureau = await createBureau({
    agents: {},
    generate: createHungGenerate(),
    toolbox: createEmptyToolbox(),
    storage: { type: 'memory' },
    durableExecution: true,
    ...overrides,
  });
  const sessionId = await createRunningBureauSession(bureau);
  return { bureau, sessionId };
}

describe('createBureau submitSessionInput mailbox-backed admission (COR-435)', () => {
  it('admits a steer-mode input, creating a SessionInputRecord and returning an accepted receipt', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession();
    try {
      const outcome = await bureau.submitSessionInput(sessionId, {
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'hello',
      });

      expect(outcome.outcome).toBe('admitted');
      const admitted = outcome as Extract<SessionInputAdmissionOutcome, { outcome: 'admitted' }>;
      expect(admitted.receipt).toMatchObject({
        sessionId,
        deliveryMode: 'steer',
        state: 'accepted',
      });
      expect(typeof admitted.receipt.id).toBe('string');
      expect(typeof admitted.receipt.admissionSequence).toBe('number');
      expect(typeof admitted.receipt.revision).toBe('number');
      expect(typeof admitted.receipt.admittedAt).toBe('string');
    } finally {
      await bureau.dispose();
    }
  });

  it('admits a queue-mode input, returning a queued receipt', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession();
    try {
      const outcome = await bureau.submitSessionInput(sessionId, {
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'hello',
      });

      expect(outcome.outcome).toBe('admitted');
      const admitted = outcome as Extract<SessionInputAdmissionOutcome, { outcome: 'admitted' }>;
      expect(admitted.receipt.state).toBe('queued');
      expect(admitted.receipt.deliveryMode).toBe('queue');
    } finally {
      await bureau.dispose();
    }
  });

  it('assigns increasing per-session admissionSequence values across distinct admissions', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession();
    try {
      const first = await bureau.submitSessionInput(sessionId, {
        id: 'input-1',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'first',
      });
      const second = await bureau.submitSessionInput(sessionId, {
        id: 'input-2',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'second',
      });

      expect(first.outcome).toBe('admitted');
      expect(second.outcome).toBe('admitted');
      const firstReceipt = (first as Extract<SessionInputAdmissionOutcome, { outcome: 'admitted' }>)
        .receipt;
      const secondReceipt = (
        second as Extract<SessionInputAdmissionOutcome, { outcome: 'admitted' }>
      ).receipt;
      expect(secondReceipt.admissionSequence).toBeGreaterThan(firstReceipt.admissionSequence);
    } finally {
      await bureau.dispose();
    }
  });

  it('replays the original receipt for an exact retry of (principal, id) with an identical (sessionId, deliveryMode, payloadDigest), instead of creating a second record', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession();
    try {
      const request = {
        id: 'retry-me',
        principal: 'alice',
        deliveryMode: 'steer' as const,
        payload: 'identical payload',
      };

      const original = await bureau.submitSessionInput(sessionId, request);
      expect(original.outcome).toBe('admitted');
      const originalReceipt = (
        original as Extract<SessionInputAdmissionOutcome, { outcome: 'admitted' }>
      ).receipt;

      const retry = await bureau.submitSessionInput(sessionId, request);
      expect(retry.outcome).toBe('replayed');
      const retryReceipt = (retry as Extract<SessionInputAdmissionOutcome, { outcome: 'replayed' }>)
        .receipt;

      // Same admissionSequence proves no second SessionInputRecord was
      // created: a genuinely new admission would have advanced it.
      expect(retryReceipt).toEqual(originalReceipt);
    } finally {
      await bureau.dispose();
    }
  });

  it('returns a conflict with reason delivery-mode-mismatch when the retry changes deliveryMode', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession();
    try {
      const original = await bureau.submitSessionInput(sessionId, {
        id: 'mode-conflict',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'same payload',
      });
      expect(original.outcome).toBe('admitted');
      const originalReceipt = (
        original as Extract<SessionInputAdmissionOutcome, { outcome: 'admitted' }>
      ).receipt;

      const conflicting = await bureau.submitSessionInput(sessionId, {
        id: 'mode-conflict',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'same payload',
      });

      expect(conflicting.outcome).toBe('conflict');
      const { conflict } = conflicting as Extract<
        SessionInputAdmissionOutcome,
        { outcome: 'conflict' }
      >;
      expect(conflict.reason).toBe('delivery-mode-mismatch');
      expect(conflict.originalReceipt).toEqual(originalReceipt);
    } finally {
      await bureau.dispose();
    }
  });

  it('returns a conflict with reason payload-mismatch when the retry changes the payload', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession();
    try {
      const original = await bureau.submitSessionInput(sessionId, {
        id: 'payload-conflict',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'original payload',
      });
      expect(original.outcome).toBe('admitted');

      const conflicting = await bureau.submitSessionInput(sessionId, {
        id: 'payload-conflict',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'a completely different payload',
      });

      expect(conflicting.outcome).toBe('conflict');
      const { conflict } = conflicting as Extract<
        SessionInputAdmissionOutcome,
        { outcome: 'conflict' }
      >;
      expect(conflict.reason).toBe('payload-mismatch');
    } finally {
      await bureau.dispose();
    }
  });

  it('returns a conflict with reason session-mismatch when the same (principal, id) targets a different session', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createHungGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const firstSessionId = await createRunningBureauSession(bureau, 'alice');
      const secondSessionId = await createRunningBureauSession(bureau, 'alice');
      expect(secondSessionId).not.toBe(firstSessionId);

      const request = {
        id: 'cross-session',
        principal: 'alice',
        deliveryMode: 'steer' as const,
        payload: 'same payload',
      };

      const original = await bureau.submitSessionInput(firstSessionId, request);
      expect(original.outcome).toBe('admitted');

      const conflicting = await bureau.submitSessionInput(secondSessionId, request);

      expect(conflicting.outcome).toBe('conflict');
      const { conflict } = conflicting as Extract<
        SessionInputAdmissionOutcome,
        { outcome: 'conflict' }
      >;
      expect(conflict.reason).toBe('session-mismatch');
    } finally {
      await bureau.dispose();
    }
  });

  it('returns a conflict with reason id-owned-by-other-principal when a different principal submits the same id in the same session', async () => {
    // `submitSessionInput`'s pre-admission authorization check
    // (`isSessionAuthorityAuthorized`) is single-owner PER RUN: a principal
    // who never owned any run on this session is rejected as `not-found`
    // before ever reaching mailbox admission (see the pre-admission
    // describe block above — that is COR-412's existing, unchanged
    // contract). So `id-owned-by-other-principal` is reachable only when
    // the SECOND principal is legitimately authorized too — i.e. a session
    // that has since been continued by a different principal's run, while
    // the first principal's earlier session-input record is still open in
    // the mailbox. This fixture builds exactly that: alice's run submits an
    // input, then bob continues the SAME session with a second run
    // (`createRun({ sessionId })`), which makes bob the current run's
    // authorized principal, and bob then collides with alice's id.
    const bureau = await createBureau({
      agents: {},
      generate: createHungGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const sessionId = await createRunningBureauSession(bureau, 'alice');

      const original = await bureau.submitSessionInput(sessionId, {
        id: 'shared-id',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'alice payload',
      });
      expect(original.outcome).toBe('admitted');

      await bureau.createRun({ message: 'continue as bob', sessionId, principal: 'bob' });
      await pollUntil(async () => {
        const session = await bureau.getSession(sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const conflicting = await bureau.submitSessionInput(sessionId, {
        id: 'shared-id',
        principal: 'bob',
        deliveryMode: 'steer',
        payload: 'alice payload',
      });

      expect(conflicting.outcome).toBe('conflict');
      const { conflict } = conflicting as Extract<
        SessionInputAdmissionOutcome,
        { outcome: 'conflict' }
      >;
      expect(conflict.reason).toBe('id-owned-by-other-principal');
    } finally {
      await bureau.dispose();
    }
  });

  it('shares a single in-flight reservation across a concurrent identical retry instead of racing a second write', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession();
    try {
      const request = {
        id: 'concurrent-retry',
        principal: 'alice',
        deliveryMode: 'steer' as const,
        payload: 'raced payload',
      };

      // Neither call is awaited before the other starts: both admission
      // attempts for the identical (principal, id) are genuinely in flight
      // at once. If they raced independently, one could observe no
      // existing record yet and admit a second one before the first's
      // write lands.
      //
      // Sharing an in-flight reservation is NOT the same thing as a later,
      // sequential replay (the separate test above already covers that
      // case): a caller who arrives while admission is still in flight
      // gets the SAME pending promise as the first caller, not a second,
      // independently-resolved lookup — so both settle to the identical
      // 'admitted' outcome, not one 'admitted' and one 'replayed'. What
      // this test actually proves is the ABSENCE of a second write: both
      // outcomes carry the same admissionSequence, which a genuinely
      // independent second admission would have advanced.
      const [first, second] = await Promise.all([
        bureau.submitSessionInput(sessionId, request),
        bureau.submitSessionInput(sessionId, request),
      ]);

      expect(first.outcome).toBe('admitted');
      expect(second).toEqual(first);
    } finally {
      await bureau.dispose();
    }
  });

  it('returns backlog-exhausted with scope session before creating a record once the per-session limit is reached', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession({
      sessionInput: { sessionBacklogLimit: 1, principalBacklogLimit: 100 },
    });
    try {
      const first = await bureau.submitSessionInput(sessionId, {
        id: 'session-backlog-1',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'one',
      });
      expect(first.outcome).toBe('admitted');

      const second = await bureau.submitSessionInput(sessionId, {
        id: 'session-backlog-2',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'two',
      });

      expect(second).toEqual({
        outcome: 'backlog-exhausted',
        scope: 'session',
        limit: 1,
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns backlog-exhausted with scope principal before creating a record once the per-principal limit is reached', async () => {
    const { bureau, sessionId } = await createDurableBureauWithRunningSession({
      sessionInput: { sessionBacklogLimit: 100, principalBacklogLimit: 1 },
    });
    try {
      const first = await bureau.submitSessionInput(sessionId, {
        id: 'principal-backlog-1',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'one',
      });
      expect(first.outcome).toBe('admitted');

      const second = await bureau.submitSessionInput(sessionId, {
        id: 'principal-backlog-2',
        principal: 'alice',
        deliveryMode: 'queue',
        payload: 'two',
      });

      expect(second).toEqual({
        outcome: 'backlog-exhausted',
        scope: 'principal',
        limit: 1,
      });
    } finally {
      await bureau.dispose();
    }
  });
});
