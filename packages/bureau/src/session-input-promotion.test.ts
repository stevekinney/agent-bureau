import { createAgentSession, createSessionStore, type SessionStore } from '@lostgradient/operative';
import {
  resolveStorage,
  textValueStore,
  type ConditionalTextValueStore,
  type Storage,
  type TextValueStoreBatchOperation,
  type TextValueStoreCondition,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import {
  admitSessionInput,
  createSessionInputMailbox,
  type SessionInputAdmissionAttempt,
} from './session-input-durability';
import {
  projectSessionInputPromotion,
  promoteSessionInput,
  SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE,
  type SessionInputPromotionAttachment,
} from './session-input-promotion';

/**
 * COR-435 AC6/AC7 — the promotion mechanism's own crash-safety contract,
 * tested directly against `SessionStore` + `Mailbox` rather than through a
 * full `Bureau`. See `session-input-promotion.ts`'s module doc for why
 * AC6's literal `ctx.memo` wording does not apply here and what replaces
 * it (the AB-389/390/391 session outbox pattern), and for the argument
 * that each crash window below is safe.
 *
 * Scope note: this file proves promotion's OWN atomicity and idempotency.
 * It does not exercise the (separate, not-yet-built) trigger that decides
 * WHEN to promote a pending session-input at a run's next safe boundary —
 * that wiring is out of scope for COR-435 (see the coordinator's ruling:
 * `ctx.memo` is structurally unreachable from where `submitSessionInput`
 * lives, and the actual step-boundary consumer belongs to
 * `packages/operative`'s run-workflow, not this package). "The message"
 * proven non-duplicated here is the durable `SessionOutboxEntry` attachment
 * describing it — the one fact a downstream conversation-append consumer
 * would drain exactly once via the outbox's own pre-existing claim/
 * acknowledge exclusivity (AB-390), not yet built here.
 */

const FIXED_NOW_ISO = '2026-01-01T00:00:00.000Z';
const fixedNowISO = () => FIXED_NOW_ISO;

async function createFixture(): Promise<{
  storage: Storage;
  sessionStore: SessionStore;
  sessionId: string;
}> {
  const storage = await resolveStorage({ type: 'memory' });
  const sessionStore = createSessionStore(textValueStore(storage));
  const sessionId = 'promotion-session';
  await sessionStore.save(
    createAgentSession({
      id: sessionId,
      agentName: 'agent',
      conversationHistory: createConversationHistory({ id: sessionId }),
    }),
  );
  return { storage, sessionStore, sessionId };
}

async function admitOneSessionInput(
  storage: Storage,
  sessionId: string,
  id: string,
): Promise<void> {
  const mailbox = createSessionInputMailbox(storage, sessionId, 100);
  const admission = await mailbox.admit({
    caller: 'alice',
    target: sessionId,
    kind: 'session-input:steer',
    payload: { form: 'inline', value: { payload: 'hello' } },
    idempotencyKey: id,
  });
  if (admission.status !== 'admitted') {
    throw new Error(`Test fixture setup failed: expected 'admitted', got '${admission.status}'.`);
  }
}

function attachmentFor(sessionId: string, id: string): SessionInputPromotionAttachment {
  return { sessionId, id, conversationMessageId: `message-for-${id}`, providerTurn: 0 };
}

/**
 * Filters a `SessionStore.outbox.pending()` listing down to this module's
 * own attachments. `sessionStore.save()` in `createFixture()` already
 * appends its own `'session.created'` entry, so raw `pending().length`
 * is not a meaningful assertion anywhere in this file.
 */
function promotionAttachments(
  entries: Awaited<ReturnType<SessionStore['outbox']['pending']>>,
): readonly unknown[] {
  return entries.filter(
    (entry) =>
      entry.kind === 'session.attachment' &&
      entry.namespace === SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE,
  );
}

/**
 * Wraps a `ConditionalTextValueStore` so its `conditionalBatch` throws for
 * the first `failCount` calls, then behaves normally — simulating a crash
 * during the durable write itself (crash window (a)), without any real
 * sleep or wall-clock dependency.
 */
function withFaultyConditionalBatch(
  base: ConditionalTextValueStore,
  failCount: number,
): ConditionalTextValueStore {
  let calls = 0;
  return {
    ...base,
    async conditionalBatch(
      conditions: TextValueStoreCondition[],
      operations: TextValueStoreBatchOperation[],
    ) {
      calls += 1;
      if (calls <= failCount) {
        throw new Error('simulated crash before the promotion batch commits');
      }
      return base.conditionalBatch(conditions, operations);
    },
  };
}

describe('promoteSessionInput / projectSessionInputPromotion (COR-435 AC6/AC7)', () => {
  it('commits the promotion atomically with exactly one session outbox entry (AC6, reframed)', async () => {
    const { storage, sessionStore, sessionId } = await createFixture();
    const id = 'input-1';
    await admitOneSessionInput(storage, sessionId, id);

    const result = await promoteSessionInput(
      sessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );

    expect(result).toEqual({
      committed: true,
      alreadyPromoted: false,
      promotion: {
        promotedAt: FIXED_NOW_ISO,
        conversationMessageId: `message-for-${id}`,
        providerTurn: 0,
      },
    });

    const session = await sessionStore.load(sessionId);
    expect(session?.metadata['sessionInputPromotions']).toEqual({
      [id]: {
        promotedAt: FIXED_NOW_ISO,
        conversationMessageId: `message-for-${id}`,
        providerTurn: 0,
      },
    });

    const pending = await sessionStore.outbox.pending();
    const attachments = promotionAttachments(pending);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ payload: attachmentFor(sessionId, id) });
  });

  it('returns committed:false with reason session-not-found for an unknown session, writing nothing', async () => {
    const { storage, sessionStore, sessionId } = await createFixture();
    const id = 'input-1';
    await admitOneSessionInput(storage, sessionId, id);

    const result = await promoteSessionInput(
      sessionStore,
      attachmentFor('no-such-session', id),
      fixedNowISO,
    );

    expect(result).toEqual({ committed: false, reason: 'session-not-found' });
    const pending = await sessionStore.outbox.pending();
    expect(promotionAttachments(pending)).toHaveLength(0);
  });

  it('crash window (a): a write that fails before the batch commits leaves nothing durable, and a clean retry commits exactly once', async () => {
    const { storage, sessionId } = await createFixture();
    const id = 'input-1';
    await admitOneSessionInput(storage, sessionId, id);

    // A SEPARATE store instance whose underlying conditionalBatch fails
    // exactly once, standing in for "the process crashed mid-write" — the
    // call never lands, nothing is committed.
    const faultyKv = withFaultyConditionalBatch(textValueStore(storage), 1);
    const faultySessionStore = createSessionStore(faultyKv);

    const attempt = promoteSessionInput(
      faultySessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );
    await expect(attempt).rejects.toThrow('simulated crash before the promotion batch commits');

    // Nothing durable happened: a fresh, real session store reads no
    // promotion and no outbox entry.
    const realSessionStore = createSessionStore(textValueStore(storage));
    const sessionAfterFailedAttempt = await realSessionStore.load(sessionId);
    expect(sessionAfterFailedAttempt?.metadata['sessionInputPromotions']).toBeUndefined();
    expect(promotionAttachments(await realSessionStore.outbox.pending())).toHaveLength(0);

    // The retry — a clean call against the real (non-faulty) store — commits
    // exactly once.
    const retryResult = await promoteSessionInput(
      realSessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );
    expect(retryResult).toEqual({
      committed: true,
      alreadyPromoted: false,
      promotion: {
        promotedAt: FIXED_NOW_ISO,
        conversationMessageId: `message-for-${id}`,
        providerTurn: 0,
      },
    });
    const attachmentsAfterRetry = promotionAttachments(await realSessionStore.outbox.pending());
    expect(attachmentsAfterRetry).toHaveLength(1);
  });

  it('crash window (b): re-calling promotion after the batch already committed reads the existing promotion as success, with no second outbox entry', async () => {
    const { storage, sessionStore, sessionId } = await createFixture();
    const id = 'input-1';
    await admitOneSessionInput(storage, sessionId, id);

    const first = await promoteSessionInput(
      sessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );
    expect(first).toMatchObject({ committed: true, alreadyPromoted: false });

    // The caller does not know whether its first call's result was ever
    // observed (the simulated crash is BETWEEN the commit landing and the
    // caller's own bookkeeping of that fact) — it calls again.
    const second = await promoteSessionInput(
      sessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );

    // Same committed promotion fact, but this call FOUND it rather than
    // creating it — that is the whole point of this crash window.
    expect(second).toMatchObject({ committed: true, alreadyPromoted: true });
    if (first.committed && second.committed) {
      expect(second.promotion).toEqual(first.promotion);
    }

    // Exactly one durable fact exists — the second call appended nothing.
    const attachments = promotionAttachments(await sessionStore.outbox.pending());
    expect(attachments).toHaveLength(1);
  });

  it('crash window (c): after both the commit and the downstream projection have landed, re-entering either is a no-op — never a second mailbox transition', async () => {
    const { storage, sessionStore, sessionId } = await createFixture();
    const id = 'input-1';
    await admitOneSessionInput(storage, sessionId, id);
    const mailbox = createSessionInputMailbox(storage, sessionId, 100);

    const promoted = await promoteSessionInput(
      sessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );
    expect(promoted.committed).toBe(true);

    const projected = await projectSessionInputPromotion(mailbox, id);
    expect(projected).toEqual({ projected: true });

    const receiptsAfterFirstProjection = await mailbox.list({ limit: 10 });
    const receiptAfterFirstProjection = await mailbox.receipt(
      receiptsAfterFirstProjection[0]!.commandId,
    );
    expect(receiptAfterFirstProjection?.state).toBe('applied');
    const attemptAfterFirstProjection = receiptAfterFirstProjection?.attempt;

    // Both crash windows re-entered: nothing left to do, nothing re-runs.
    const promotedAgain = await promoteSessionInput(
      sessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );
    expect(promotedAgain).toMatchObject({ committed: true, alreadyPromoted: true });
    if (promoted.committed && promotedAgain.committed) {
      expect(promotedAgain.promotion).toEqual(promoted.promotion);
    }
    const attachmentsAfterReentry = promotionAttachments(await sessionStore.outbox.pending());
    expect(attachmentsAfterReentry).toHaveLength(1);

    const projectedAgain = await projectSessionInputPromotion(mailbox, id);
    expect(projectedAgain).toEqual({ projected: false, reason: 'nothing-to-claim' });

    const receiptsAfterSecondProjection = await mailbox.list({ limit: 10 });
    const receiptAfterSecondProjection = await mailbox.receipt(
      receiptsAfterSecondProjection[0]!.commandId,
    );
    // The mailbox command's own attempt count never advanced a second time —
    // the SAME `applied` transition from the first projection, not a new one.
    expect(receiptAfterSecondProjection?.state).toBe('applied');
    expect(receiptAfterSecondProjection?.attempt).toBe(attemptAfterFirstProjection);
  });

  it('projectSessionInputPromotion rejects-with-retry a claimed command that does not match the target id', async () => {
    const { storage, sessionId } = await createFixture();
    await admitOneSessionInput(storage, sessionId, 'someone-elses-input');
    const mailbox = createSessionInputMailbox(storage, sessionId, 100);

    const result = await projectSessionInputPromotion(mailbox, 'not-the-admitted-id');
    expect(result).toEqual({ projected: false, reason: 'not-our-record' });

    // Rejected WITH retry — the command returns to the queue, available for
    // whoever actually owns it, rather than its lease being silently lost.
    const receipts = await mailbox.list({ limit: 10 });
    expect(receipts[0]?.state).not.toBe('dead-lettered');
  });

  it('a replay of an already-promoted record reports state: promoted, not accepted/queued (coordinator-ruled correctness fix)', async () => {
    // Regression: `buildReceipt` (session-input-durability.ts) used to
    // derive `state` from `deliveryMode` alone, so a caller idempotently
    // retrying `(principal, id)` after its input was promoted was told the
    // input was still `accepted` — acting on stale information about
    // exactly the thing it was checking. The fix consults
    // `readSessionInputPromotion` on the replay path.
    const { storage, sessionStore, sessionId } = await createFixture();
    const kv = textValueStore(storage);
    const mailbox = createSessionInputMailbox(storage, sessionId, 100);
    const id = 'input-1';

    const attempt = (): SessionInputAdmissionAttempt => ({
      storage,
      kv,
      sessionStore,
      sessionMailbox: mailbox,
      sessionId,
      id,
      principal: 'alice',
      deliveryMode: 'steer',
      payload: { payload: 'hello' },
      principalBacklogLimit: 100,
      sessionBacklogLimitForCrossSessionRead: 100,
      nowMs: Date.now(),
    });

    const admitted = await admitSessionInput(attempt());
    expect(admitted.outcome).toBe('admitted');
    if (admitted.outcome === 'admitted') {
      expect(admitted.receipt.state).toBe('accepted');
    }

    const promoted = await promoteSessionInput(
      sessionStore,
      attachmentFor(sessionId, id),
      fixedNowISO,
    );
    expect(promoted.committed).toBe(true);

    const replay = await admitSessionInput(attempt());
    expect(replay.outcome).toBe('replayed');
    if (replay.outcome === 'replayed') {
      expect(replay.receipt.state).toBe('promoted');
    }
  });
});
