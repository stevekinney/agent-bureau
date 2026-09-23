import type {
  SessionInputAdmissionOutcome,
  SessionInputDeliveryMode,
  SessionInputPayload,
  SessionInputPromotion,
  SessionInputReceipt,
  SessionStore,
} from '@lostgradient/operative';
import {
  encodeStorageKeyComponent,
  Mailbox,
  type ApplicationCommandReceipt,
  type ConditionalTextValueStore,
  type Storage,
} from '@lostgradient/weft';

import { readSessionInputPromotion } from './session-input-promotion';

/**
 * COR-435 — durable, mailbox-backed `submitSessionInput` admission.
 *
 * ## One mailbox for the durable log, one small KV index for cross-session identity
 *
 * WFT-84's `Mailbox` binds idempotency to `(caller, target, kind,
 * payloadDigest)` within one `(namespace, resourceId)` scope. That is exactly
 * right for everything AC3 asks EXCEPT one case:
 *
 * - The SESSION mailbox (`resourceId: sessionId`) is the durable log AND the
 *   FIFO/backlog authority for one session. `caller` is the submitting
 *   principal, `target` is fixed to `sessionId` (trivial within this
 *   mailbox), `kind` encodes `deliveryMode`, and the payload is the
 *   caller's own content. Because `id` is unique WITHIN a session regardless
 *   of principal (AB-42's 2026-09-02 coordinator amendment), `idempotencyKey`
 *   here is `id` alone. This one mailbox, one `admit()` call, and Weft's own
 *   idempotency-vs-backlog ordering (idempotency resolved BEFORE the backlog
 *   check — see `mailbox-admission.ts`) together produce `replayed`,
 *   `delivery-mode-mismatch`, `payload-mismatch`, `id-owned-by-other-principal`,
 *   and the native per-session `backlog-exhausted` correctly and atomically.
 *
 * - `session-mismatch` — the same `(principal, id)` retried against a
 *   DIFFERENT session — is structurally invisible to the session mailbox: a
 *   retry against a different `sessionId` lands in an entirely different
 *   mailbox instance. Catching it needs a second index, but a whole second
 *   `Mailbox` is heavy machinery for a `(principal, id) -> sessionId`
 *   lookup, and its records would never terminalize (nothing ever claims or
 *   acknowledges them), growing an identity mailbox without bound for a
 *   principal who legitimately submits many distinct ids over a long
 *   process lifetime — a real, disclosed problem in an earlier version of
 *   this module, not a hypothetical one.
 *
 *   This version replaces that mailbox with a small, TTL-bounded record in
 *   `runtime.kv` (`ConditionalTextValueStore` — the SAME text-value store
 *   `createSessionStore` builds sessions over; see `runtime-composition.ts`
 *   lines ~1731-1743, "Keep the raw Storage so the durable engine can share
 *   the exact backend with the text-value KV view"). One key per
 *   `(principal, id)`, compare-and-swapped via `kv.conditionalBatch`. An
 *   entry older than `SESSION_INPUT_IDENTITY_TTL_MS` is treated as absent —
 *   claimable again — rather than kept forever: overwriting an expired
 *   entry keeps each key's OWN storage bounded (a stale value is replaced,
 *   never accumulated), and the tradeoff this makes explicit is that
 *   `session-mismatch` is only guaranteed detectable for an id reused
 *   within that window. Beyond it, an old id can be reused across sessions
 *   undetected. That is a deliberate, bounded cost — not a solved problem
 *   either, but a materially smaller and more honest one than "one entry
 *   per id, forever, with no eviction," which is what the mailbox-backed
 *   version actually shipped. Physical garbage collection of expired keys
 *   (as opposed to logical treat-as-absent) is not implemented in this
 *   slice; an expired key's bytes persist until a future write to the same
 *   `(principal, id)` overwrites them.
 */

/** Weft namespaces this Bureau's session-input mailboxes. Opaque to Weft. */
const SESSION_INPUT_NAMESPACE = 'corvidae.bureau.session-input';

/** Key prefix for the cross-session identity index in `runtime.kv`. */
const SESSION_INPUT_IDENTITY_KEY_PREFIX = 'session-input-identity:v1';

/**
 * How long a `(principal, id) -> sessionId` identity claim is honored
 * before being treated as absent. Matches Weft's own default
 * `terminalRetentionMs` (`MailboxOptions.terminalRetentionMs`) — the same
 * order of magnitude this codebase already uses for "how long does a
 * completed durable fact stay meaningful" elsewhere.
 */
const SESSION_INPUT_IDENTITY_TTL_MS = 86_400_000;

/** Bounds the compare-and-swap retry loop against concurrent claimants of the same key. */
const SESSION_INPUT_IDENTITY_MAX_CAS_ATTEMPTS = 10;

/** One session's session-input mailbox — the durable log, FIFO sequencer, and per-session backlog authority. */
export function createSessionInputMailbox(
  storage: Storage,
  sessionId: string,
  sessionBacklogLimit: number,
): Mailbox {
  return new Mailbox({
    storage,
    namespace: SESSION_INPUT_NAMESPACE,
    resourceId: sessionId,
    maxBacklog: sessionBacklogLimit,
  });
}

function sessionInputIdentityKey(principal: string, id: string): string {
  // Each component is encoded individually (this codebase's established
  // colon-delimited key convention — see `encodeStorageKeyComponent`'s own
  // doc comment and its use throughout `packages/weft/src/core`'s key
  // builders) so neither `principal` nor `id` can inject a stray `:` that
  // merges two components, or any other byte that would stop this file
  // from being read as plain text — a raw delimiter byte embedded directly
  // in the template literal is exactly the mistake this convention exists
  // to prevent.
  return `${SESSION_INPUT_IDENTITY_KEY_PREFIX}:${encodeStorageKeyComponent(principal)}:${encodeStorageKeyComponent(id)}`;
}

interface SessionInputIdentityRecord {
  readonly sessionId: string;
  readonly recordedAtMs: number;
}

function parseSessionInputIdentityRecord(
  raw: string | null,
): SessionInputIdentityRecord | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { sessionId?: unknown }).sessionId === 'string' &&
      typeof (parsed as { recordedAtMs?: unknown }).recordedAtMs === 'number'
    ) {
      return parsed as SessionInputIdentityRecord;
    }
    return undefined;
  } catch {
    // Malformed JSON is treated exactly like an absent key (claimable) —
    // fails open toward "no cross-session memory" rather than fails closed
    // toward "permanently stuck," matching how an expired entry is handled.
    return undefined;
  }
}

type SessionInputIdentityResult =
  | { readonly matches: true; readonly created: boolean }
  | { readonly matches: false; readonly existingSessionId: string };

/**
 * Claims (or confirms) this `(principal, id)` pair's identity as belonging
 * to `sessionId`. See the module doc for the TTL-bounded design.
 *
 * `created: true` means this call itself wrote the identity record (either
 * genuinely fresh, or refreshing one that had expired) — the caller uses
 * this to decide whether a principal-backlog check is warranted (a REPLAY
 * within the SAME session, `created: false`, must never be blocked by
 * backlog, since it creates nothing new).
 */
async function claimSessionInputIdentity(
  kv: ConditionalTextValueStore,
  principal: string,
  id: string,
  sessionId: string,
  nowMs: number,
): Promise<SessionInputIdentityResult> {
  const key = sessionInputIdentityKey(principal, id);
  for (let attempt = 0; attempt < SESSION_INPUT_IDENTITY_MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = await kv.get(key);
    const current = parseSessionInputIdentityRecord(currentRaw);
    const currentIsLive =
      current !== undefined && nowMs - current.recordedAtMs <= SESSION_INPUT_IDENTITY_TTL_MS;
    if (currentIsLive && current) {
      if (current.sessionId === sessionId) return { matches: true, created: false };
      return { matches: false, existingSessionId: current.sessionId };
    }
    // Absent, or expired (treated as absent) — claim it for this session.
    const nextValue = JSON.stringify({
      sessionId,
      recordedAtMs: nowMs,
    } satisfies SessionInputIdentityRecord);
    const committed = await kv.conditionalBatch(
      [{ key, expectedValue: currentRaw }],
      [{ type: 'set', key, value: nextValue }],
    );
    if (committed) return { matches: true, created: true };
    // Lost the compare-and-swap race — someone else wrote this key between
    // the read and the write above. Re-read and retry against fresh state.
  }
  throw new Error(
    `Session-input identity index exceeded ${SESSION_INPUT_IDENTITY_MAX_CAS_ATTEMPTS} compare-and-swap attempts for principal "${principal}", id "${id}".`,
  );
}

/** The payload a session input persists as, inside the session mailbox's inline command payload. */
export interface PersistedSessionInput {
  readonly payload: SessionInputPayload;
  readonly expiresAt?: string | undefined;
  readonly supersedes?: string | undefined;
}

function encodeSessionInputKind(deliveryMode: SessionInputDeliveryMode): string {
  return `session-input:${deliveryMode}`;
}

/** Inverse of {@link encodeSessionInputKind}. Throws on a kind this module never produced. */
function decodeSessionInputKind(kind: string): SessionInputDeliveryMode {
  if (kind === 'session-input:steer') return 'steer';
  if (kind === 'session-input:queue') return 'queue';
  throw new Error(
    `Unrecognized session-input mailbox command kind "${kind}" — expected "session-input:steer" or "session-input:queue".`,
  );
}

/**
 * Builds the fixed {@link SessionInputReceipt} shape from a session mailbox's
 * own receipt.
 *
 * `revision` is fixed at `1`: nothing in this slice amends a record in
 * place. `state` defaults to deriving from `deliveryMode` (correct for a
 * BRAND NEW admission — nothing has had a chance to promote it yet), but
 * `promotion`, when supplied, overrides that to `'promoted'`. A
 * session-input's own domain state is tracked separately, in session
 * metadata, by `session-input-promotion.ts` — every caller building a
 * receipt for an EXISTING record (a replay, or a conflict's
 * `originalReceipt`) must pass that record's current promotion (via
 * {@link readSessionInputPromotion}), never assume `deliveryMode` still
 * describes it. Coordinator-ruled correctness fix: a replay of an
 * already-promoted record used to report `accepted`/`queued`, telling a
 * legitimately-retrying caller the input was still waiting for a boundary
 * it had already passed.
 */
function buildReceipt(
  receipt: ApplicationCommandReceipt,
  deliveryMode: SessionInputDeliveryMode,
  promotion: SessionInputPromotion | undefined,
): SessionInputReceipt {
  if (receipt.idempotencyKey === undefined) {
    // Every admission through this module always supplies `idempotencyKey`
    // (the caller-facing `id`, generated when the caller omits one) —
    // reachable only if a future caller of this module stops doing that.
    throw new Error(
      'Session-input mailbox receipt is missing its idempotencyKey (caller-facing id).',
    );
  }
  return {
    id: receipt.idempotencyKey,
    sessionId: receipt.target,
    deliveryMode,
    admissionSequence: receipt.sequence,
    revision: 1,
    state: promotion !== undefined ? 'promoted' : deliveryMode === 'steer' ? 'accepted' : 'queued',
    admittedAt: new Date(receipt.acceptedAt).toISOString(),
  };
}

/** Non-terminal `ApplicationCommandState`s — mirrors what counts toward a mailbox's own `openCount`. */
const OPEN_STATES = ['accepted', 'available', 'claimed', 'cancellation-requested'] as const;

/**
 * How many of a session mailbox's currently-open (non-terminal) commands
 * were submitted by `principal`.
 *
 * A manual, best-effort count — Weft has no native per-caller sub-quota
 * within one mailbox, so unlike the native per-session `maxBacklog` check
 * (atomic, inside `admit()`'s own compare-and-swap), this read-then-decide
 * has a benign race under CONCURRENT distinct submissions from the same
 * principal: two callers can both read a count under the limit and both
 * proceed to admit, together exceeding `principalBacklogLimit` by a small
 * margin. Disclosed and accepted (coordinator ruling): it degrades to
 * admitting slightly over the cap under concurrent distinct submissions,
 * which is not a correctness violation — a stronger guarantee would need
 * Weft to expose a native per-caller counter, which it does not today.
 */
async function countOpenCommandsForPrincipal(mailbox: Mailbox, principal: string): Promise<number> {
  const receipts = await mailbox.list({ limit: 1000, states: OPEN_STATES });
  return receipts.filter((receipt) => receipt.caller === principal).length;
}

/**
 * Reconstructs the original {@link SessionInputReceipt} for a `session-mismatch`
 * conflict, by locating the record the identity index says this
 * `(principal, id)` actually belongs to.
 */
async function reconstructCrossSessionReceipt(
  storage: Storage,
  sessionStore: Pick<SessionStore, 'load'>,
  originalSessionId: string,
  id: string,
  sessionBacklogLimitForRead: number,
): Promise<SessionInputReceipt> {
  const originalMailbox = createSessionInputMailbox(
    storage,
    originalSessionId,
    sessionBacklogLimitForRead,
  );
  const receipts = await originalMailbox.list({ limit: 1000 });
  const match = receipts.find((receipt) => receipt.idempotencyKey === id);
  if (match === undefined) {
    // Rare: requires the original session's record to have independently
    // reached a terminal state and been swept past `terminalRetentionMs`
    // while the identity index's own (longer-lived, TTL-bounded) entry is
    // still live — not reachable by anything AC1-5 exercises. Fails closed
    // rather than fabricating a receipt.
    throw new Error(
      `Session-input identity index names session "${originalSessionId}" for id "${id}", but no matching record was found there.`,
    );
  }
  // The ORIGINAL session, not the one this admission attempt targets — a
  // session-mismatch conflict's `originalReceipt` must reflect whatever
  // that other record's OWN current state is, promoted or not.
  const originalSession = await sessionStore.load(originalSessionId);
  const promotion = originalSession
    ? readSessionInputPromotion(originalSession.metadata, id)
    : undefined;
  return buildReceipt(match, decodeSessionInputKind(match.kind), promotion);
}

/** Input to {@link admitSessionInput}, gathering everything the admission decision needs. */
export interface SessionInputAdmissionAttempt {
  readonly storage: Storage;
  readonly kv: ConditionalTextValueStore;
  readonly sessionStore: Pick<SessionStore, 'load'>;
  readonly sessionMailbox: Mailbox;
  readonly sessionId: string;
  readonly id: string;
  readonly principal: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  readonly payload: PersistedSessionInput;
  readonly principalBacklogLimit: number;
  readonly sessionBacklogLimitForCrossSessionRead: number;
  readonly nowMs: number;
}

/**
 * Runs one admission attempt against the mailbox-plus-identity-index scheme
 * the module doc describes. Returns exactly the outcomes
 * `Bureau.submitSessionInput` contracts for once a mailbox is composed:
 * `admitted`, `replayed`, `conflict`, `backlog-exhausted`.
 */
export async function admitSessionInput(
  attempt: SessionInputAdmissionAttempt,
): Promise<SessionInputAdmissionOutcome> {
  const {
    storage,
    kv,
    sessionStore,
    sessionMailbox,
    sessionId,
    id,
    principal,
    deliveryMode,
    payload,
    principalBacklogLimit,
    sessionBacklogLimitForCrossSessionRead,
    nowMs,
  } = attempt;

  // Fresh, not the caller's earlier snapshot: `submitSessionInput` loads the
  // session once, up front, for the pre-admission authorization/lifecycle
  // checks — but a promotion can land in the time between that load and
  // this admission attempt actually running (especially once an in-flight
  // reservation defers it), so a REPLAY or CONFLICT receipt describing an
  // EXISTING record must read this session's CURRENT promotion state, not
  // whatever it was when `submitSessionInput` started.
  async function currentPromotion(): Promise<SessionInputPromotion | undefined> {
    const current = await sessionStore.load(sessionId);
    return current ? readSessionInputPromotion(current.metadata, id) : undefined;
  }

  const identity = await claimSessionInputIdentity(kv, principal, id, sessionId, nowMs);

  if (!identity.matches) {
    const originalReceipt = await reconstructCrossSessionReceipt(
      storage,
      sessionStore,
      identity.existingSessionId,
      id,
      sessionBacklogLimitForCrossSessionRead,
    );
    return {
      outcome: 'conflict',
      conflict: { id, reason: 'session-mismatch', originalReceipt },
    };
  }

  // The principal backlog is checked ONLY when the identity claim was
  // genuinely fresh: a matched-existing claim (`created: false`) means the
  // real session-mailbox record for this id already exists, and a replay
  // of it must never be blocked by backlog — it creates nothing new. AC5
  // ("before a record is created") is satisfied because this check runs
  // before the real mailbox's own `admit()` call below, which is the one
  // that could create a record.
  if (identity.created) {
    const openForPrincipal = await countOpenCommandsForPrincipal(sessionMailbox, principal);
    if (openForPrincipal >= principalBacklogLimit) {
      return { outcome: 'backlog-exhausted', scope: 'principal', limit: principalBacklogLimit };
    }
  }

  const admission = await sessionMailbox.admit({
    caller: principal,
    target: sessionId,
    kind: encodeSessionInputKind(deliveryMode),
    payload: { form: 'inline', value: payload as unknown as Record<string, unknown> },
    idempotencyKey: id,
  });

  switch (admission.status) {
    case 'admitted':
      // Genuinely brand new: nothing has had a chance to promote it yet.
      return {
        outcome: 'admitted',
        receipt: buildReceipt(admission.receipt, deliveryMode, undefined),
      };
    case 'duplicate':
      return {
        outcome: 'replayed',
        receipt: buildReceipt(
          admission.receipt,
          decodeSessionInputKind(admission.receipt.kind),
          await currentPromotion(),
        ),
      };
    case 'conflict': {
      const reason =
        admission.receipt.caller !== principal
          ? ('id-owned-by-other-principal' as const)
          : admission.receipt.kind !== encodeSessionInputKind(deliveryMode)
            ? ('delivery-mode-mismatch' as const)
            : ('payload-mismatch' as const);
      return {
        outcome: 'conflict',
        conflict: {
          id,
          reason,
          originalReceipt: buildReceipt(
            admission.receipt,
            decodeSessionInputKind(admission.receipt.kind),
            await currentPromotion(),
          ),
        },
      };
    }
    case 'rejected':
      return {
        outcome: 'backlog-exhausted',
        scope: 'session',
        limit: admission.capacity.limit,
      };
  }
}
