import type { JSONValue, SessionInputPromotion, SessionStore } from '@lostgradient/operative';
import type { Mailbox } from '@lostgradient/weft';

/**
 * COR-435 AC6/AC7 — promotes an admitted session-input (`accepted`/`queued`)
 * to `promoted`: the durable fact that it became a model-visible message,
 * committed atomically, plus the downstream projection that settles the
 * underlying Weft mailbox command.
 *
 * ## Why not `ctx.memo` (AC6's literal wording)
 *
 * AC6 as filed says "a single dedicated `ctx.memo` step whose entire body is
 * one `conditionalBatch`". That wording was written against the old
 * `agent-bureau` repository. In this repository, `ctx.memo` and
 * `durableActivity()` (`packages/weft/src/core/context/durable-activity.ts`)
 * exist ONLY inside an active workflow generator's execution — confirmed by
 * that module's own `AsyncLocalStorage`-scoped `DurableActivityScope`, which
 * throws `DurableActivityScopeError` outside one. `Bureau.submitSessionInput`
 * (and everything this module is called from) runs OUTSIDE any workflow,
 * exactly like `submitSteeringCommand` today — there is no `ctx` here to
 * call `.memo()` on. That is a structural fact about where this method
 * lives, not an oversight, and the coordinator ruled explicitly: the
 * OBSERVABLE contract (AC7 — one correct outcome per crash window, never a
 * duplicate message, never a second mailbox transition) governs; the named
 * mechanism does not.
 *
 * ## What replaces it: the session outbox (AB-389/390/391)
 *
 * `create-bureau.ts` already solves the identical problem — "commit a
 * durable fact atomically with a state transition, then project the
 * derived effect downstream idempotently" — for review-transition audit
 * records (see its AB-391 comment block, "review-transition audit records
 * ride the session outbox"). `SessionStore.update()`'s public
 * `options.outbox` (`@lostgradient/operative`) appends a `SessionOutboxEntry`
 * in the SAME `conditionalBatch` as the session's own metadata commit.
 * `SessionStore` and the session-input `Mailbox` share one underlying
 * `Storage` instance whenever a bureau is durably configured with a single
 * backend (`runtime-composition.ts` ~line 1731: "Keep the raw Storage so
 * the durable engine can share the exact backend with the text-value KV
 * view") — but that shared backend does NOT make Weft's own internal
 * mailbox record reachable from bureau's own `conditionalBatch` calls: its
 * key encoding is private to `packages/weft/src/core/mailbox-internals.ts`
 * and never exported. So "the record's promoted transition" here is
 * BUREAU'S OWN domain state for the record (tracked in
 * `session.metadata['sessionInputPromotions'][id]`), not Weft's — a
 * distinction `session-input-durability.ts`'s `buildReceipt()` already
 * anticipated. The session commit is the atomicity boundary AC7 actually
 * needs; the Weft mailbox's own `applied` transition is a downstream,
 * idempotent bookkeeping step (`projectSessionInputPromotion` below), kept
 * separate on purpose so a repeated call can never double-settle it.
 *
 * ## The three crash windows (AC7)
 *
 * - (a) crash before `promoteSessionInput`'s batch commits: nothing durable
 *   happened. A retry calls `promoteSessionInput` again; `SessionStore.update`'s
 *   own optimistic-concurrency read-decide-commit starts fresh and commits
 *   exactly once.
 * - (b) crash between the batch committing and the caller's own bookkeeping
 *   of having called it landing: the caller (not knowing whether its last
 *   call actually landed) calls `promoteSessionInput` again. The updater
 *   reads `session.metadata['sessionInputPromotions'][id]`, finds it
 *   already present, and returns `undefined` (a no-op commit) — per
 *   `SessionStore.update()`'s own contract, a no-op commit appends NO
 *   outbox entries, so nothing replays a second time. This function
 *   returns the EXISTING promotion, reported as success.
 * - (c) crash after both the session commit AND the downstream projection
 *   have landed: calling `promoteSessionInput` again hits the same
 *   already-promoted no-op as (b); calling `projectSessionInputPromotion`
 *   again finds the Weft command already terminal (`mailbox.claim()`
 *   resolves `'empty'`, nothing available) and does nothing. Both are
 *   no-ops — there is nothing to re-enter.
 *
 * @module session-input-promotion
 */

/** `SessionOutboxEntry.namespace` this module's attachments use. Opaque to `SessionStore`. */
export const SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE = 'session-input-promotion';

/** The durable fact riding the session outbox alongside the promotion commit. */
export interface SessionInputPromotionAttachment {
  readonly sessionId: string;
  readonly id: string;
  readonly conversationMessageId: string;
  readonly providerTurn: number;
}

export type PromoteSessionInputResult =
  | {
      readonly committed: true;
      readonly promotion: SessionInputPromotion;
      /** `true` when this call found an existing promotion rather than creating one — crash windows (b)/(c). */
      readonly alreadyPromoted: boolean;
    }
  | { readonly committed: false; readonly reason: 'session-not-found' };

function isPlainRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionInputPromotion(
  value: JSONValue | undefined,
): value is JSONValue & SessionInputPromotion {
  return (
    isPlainRecord(value) &&
    typeof value['promotedAt'] === 'string' &&
    typeof value['conversationMessageId'] === 'string' &&
    typeof value['providerTurn'] === 'number'
  );
}

/**
 * Reads `id`'s {@link SessionInputPromotion} out of a session's own
 * metadata, or `undefined` when `id` has never been promoted (or the
 * session predates this field, or the stored value is malformed —
 * fails closed toward "not promoted" rather than fabricating a promotion).
 *
 * Shared by `session-input-durability.ts` so a replayed or conflicting
 * admission's receipt can report the record's ACTUAL current state rather
 * than guessing `accepted`/`queued` for a record that has since promoted —
 * the same `sessionInputPromotions` map `promoteSessionInput` writes to,
 * read the same way, so the two modules can never disagree about its shape.
 */
export function readSessionInputPromotion(
  metadata: Record<string, JSONValue>,
  id: string,
): SessionInputPromotion | undefined {
  const promotions = metadata['sessionInputPromotions'];
  if (!isPlainRecord(promotions)) return undefined;
  const candidate = promotions[id];
  return isSessionInputPromotion(candidate) ? candidate : undefined;
}

/**
 * Commits a session-input's `promoted` transition. See the module doc for
 * the full crash-safety argument. Idempotent: a second call for an already-
 * promoted `id` returns the existing promotion and writes nothing new.
 */
export async function promoteSessionInput(
  sessionStore: SessionStore,
  attachment: SessionInputPromotionAttachment,
  nowISO: () => string,
): Promise<PromoteSessionInputResult> {
  const { sessionId, id, conversationMessageId, providerTurn } = attachment;

  let outcome:
    | { readonly kind: 'promoted-now'; readonly promotion: SessionInputPromotion }
    | { readonly kind: 'already-promoted'; readonly promotion: SessionInputPromotion }
    | { readonly kind: 'not-found' }
    | undefined;

  await sessionStore.update(
    sessionId,
    (session) => {
      if (!session) {
        outcome = { kind: 'not-found' };
        return undefined;
      }
      const promotions = isPlainRecord(session.metadata['sessionInputPromotions'])
        ? session.metadata['sessionInputPromotions']
        : {};
      const existing = promotions[id];
      if (isSessionInputPromotion(existing)) {
        // Already promoted — a no-op commit. `SessionStore.update()` skips
        // appending outbox entries when the updater returns `undefined`, so
        // this genuinely writes nothing: no second durable fact, no second
        // drain trigger.
        outcome = { kind: 'already-promoted', promotion: existing };
        return undefined;
      }
      const promotion: SessionInputPromotion = {
        promotedAt: nowISO(),
        conversationMessageId,
        providerTurn,
      };
      outcome = { kind: 'promoted-now', promotion };
      return {
        ...session,
        metadata: {
          ...session.metadata,
          sessionInputPromotions: {
            ...promotions,
            [id]: promotion as unknown as JSONValue,
          },
        },
      };
    },
    {
      // Ignored by `SessionStore.update()` when the updater above returns
      // `undefined` (the already-promoted branch) — see that option's own
      // doc comment. The cast matches `create-bureau.ts`'s existing
      // `reviewAuditOutboxAttachment` (AB-391): `SessionOutboxEntry.payload`
      // is `JSONValue`, and a `readonly`-fielded interface has no index
      // signature TypeScript can match structurally — the value itself is
      // already plain, JSON-safe data.
      outbox: [
        {
          namespace: SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE,
          payload: attachment as unknown as JSONValue,
        },
      ],
    },
  );

  if (outcome === undefined) {
    // `SessionStore.update()`'s updater always runs at least once before
    // the call resolves — unreachable in practice, defensive only.
    throw new Error(
      `promoteSessionInput: session store update for "${sessionId}" never invoked its updater.`,
    );
  }
  if (outcome.kind === 'not-found') return { committed: false, reason: 'session-not-found' };
  return {
    committed: true,
    promotion: outcome.promotion,
    alreadyPromoted: outcome.kind === 'already-promoted',
  };
}

export type ProjectSessionInputPromotionResult =
  | { readonly projected: true }
  | { readonly projected: false; readonly reason: 'nothing-to-claim' | 'not-our-record' };

/**
 * The downstream half of promotion: settles the underlying Weft
 * session-input mailbox command as `applied`, so the mailbox's own backlog
 * accounting reflects that the record is no longer open.
 *
 * Idempotent by construction, not by an explicit check: once the command is
 * terminal, `mailbox.claim()` finds nothing available (`status: 'empty'`)
 * and this is a no-op — the same guarantee crash window (c) relies on. A
 * command that claims but does not match `id` (a different session-input
 * happened to be next in this mailbox's FIFO order) is rejected WITH
 * retry, so its lease is never silently dropped.
 */
export async function projectSessionInputPromotion(
  mailbox: Mailbox,
  id: string,
): Promise<ProjectSessionInputPromotionResult> {
  const claimResult = await mailbox.claim();
  if (claimResult.status !== 'claimed') {
    return { projected: false, reason: 'nothing-to-claim' };
  }
  const { claim } = claimResult;
  if (claim.receipt.idempotencyKey !== id) {
    await mailbox.reject({
      commandId: claim.receipt.commandId,
      attemptToken: claim.attemptToken,
      failure: {
        reason: 'application',
        message: 'claimed a different session-input than this promotion targeted',
      },
      retry: true,
    });
    return { projected: false, reason: 'not-our-record' };
  }
  await mailbox.acknowledge({
    commandId: claim.receipt.commandId,
    attemptToken: claim.attemptToken,
  });
  return { projected: true };
}
