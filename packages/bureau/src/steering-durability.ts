import type { Storage } from '@lostgradient/weft';
import { Mailbox } from '@lostgradient/weft';

import type { ImplementedSteeringCommand } from './steering';

/**
 * AB-200 — durable steering: the mailbox a durably-configured Bureau
 * persists admitted steering commands into, so an `accepted` command
 * survives a process restart instead of living only in the in-memory
 * gate.
 *
 * ## Why a mailbox and not a bespoke key
 *
 * WFT-84's `Mailbox` already owns exactly this problem — FIFO ordering
 * within one resource, idempotent admission bound to
 * `(caller, target, kind, payloadDigest)`, a receipt that survives
 * restart, and state transitions committed atomically with their fleet
 * event. Writing steering's own records against `Storage` directly would
 * reimplement all of it, worse. AB-67's own record anticipated this:
 * steering persistence is "a projection of the same mailbox
 * envelope/receipt contract".
 *
 * ## The division of authority
 *
 * The in-memory `BureauSteeringGate` stays the authority for *desired
 * state* — it owns `configVersion` accounting, per-run pause scoping and
 * supersession, and none of that belongs in a durable queue. The mailbox
 * is the durable *log*: what was admitted, by whom, and whether it has
 * been consumed. On restart the log is replayed back into a fresh gate.
 *
 * That ordering matters. A command is written to the mailbox *before* it
 * reaches the gate, so a crash between the two loses nothing — recovery
 * finds it still un-consumed and replays it. The reverse order would
 * admit a command into desired state that no restart could ever recover.
 */

/** Weft namespaces this Bureau's steering mailboxes. Opaque to Weft. */
const STEERING_NAMESPACE = 'corvidae.bureau.steering';

/**
 * One session's steering mailbox. Sessions get their own `resourceId`
 * because FIFO order is meaningful within a session and meaningless
 * across unrelated ones.
 */
export function createSteeringMailbox(storage: Storage, sessionId: string): Mailbox {
  return new Mailbox({
    storage,
    namespace: STEERING_NAMESPACE,
    resourceId: sessionId,
  });
}

/** The payload a steering command persists as. */
export interface PersistedSteeringCommand {
  readonly id: string;
  readonly sessionId: string;
  readonly principal: string;
  readonly requestedValue: ImplementedSteeringCommand['requestedValue'];
  readonly requestedAt: string;
  readonly runId?: string | undefined;
  readonly expectedRevision?: number | undefined;
  readonly deadline?: string | undefined;
}

/**
 * Persists one admitted steering command. Returns the mailbox's own
 * command id, or `undefined` when the backlog rejected it before writing
 * anything.
 *
 * `idempotencyKey` is the caller-facing command id, so an exact retry
 * replays the original receipt rather than creating a second command —
 * the same idempotency the in-memory gate's ledger provides, now
 * surviving restart.
 */
export async function persistSteeringCommand(
  mailbox: Mailbox,
  command: ImplementedSteeringCommand,
): Promise<{ persisted: true; commandId: string } | { persisted: false; reason: string }> {
  const payload: PersistedSteeringCommand = {
    id: command.id,
    sessionId: command.sessionId,
    principal: command.principal,
    requestedValue: command.requestedValue,
    requestedAt: command.requestedAt,
    ...(command.runId !== undefined ? { runId: command.runId } : {}),
    ...(command.expectedRevision !== undefined
      ? { expectedRevision: command.expectedRevision }
      : {}),
    ...(command.deadline !== undefined ? { deadline: command.deadline } : {}),
  };

  const admission = await mailbox.admit({
    caller: command.principal,
    target: command.sessionId,
    kind: `steering:${command.requestedValue.target}`,
    payload: { form: 'inline', value: payload as unknown as Record<string, unknown> },
    idempotencyKey: command.id,
  });

  switch (admission.status) {
    case 'admitted':
    case 'duplicate':
      return { persisted: true, commandId: admission.receipt.commandId };
    case 'conflict':
      return { persisted: false, reason: 'idempotency-identity-mismatch' };
    case 'rejected':
      return { persisted: false, reason: admission.reason };
  }
}

/**
 * Drains this session's steering mailbox, in FIFO order, for replay into a
 * fresh gate after a restart.
 *
 * Claim, replay, acknowledge — not a passive read. A receipt from `list()`
 * carries only metadata (`payloadDigest`, `payloadForm`); the payload
 * itself is delivered on `claim()`, digest-verified. Claiming is also the
 * correct semantic rather than a workaround: recovery genuinely *consumes*
 * each command into desired state, and acknowledging says so.
 *
 * A crash midway is safe by construction, but only because `apply` runs
 * before the acknowledgement for each command individually. A
 * claimed-but-unacknowledged command's visibility lease expires and it
 * returns to the queue head, so the next boot replays it. The cost of
 * that safety is at-least-once replay, which is harmless here precisely
 * because replay is idempotent: re-applying "desired model is X" yields
 * the same desired state, and the gate's own value-idempotency check
 * declines to advance `configVersion` for a value already in force.
 *
 * `maximumCommands` bounds one drain so a pathological backlog cannot
 * stall boot indefinitely; the remainder stays durable for the next pass.
 */
export async function recoverSteeringCommands(
  mailbox: Mailbox,
  apply: (command: PersistedSteeringCommand) => void,
  maximumCommands = 1000,
): Promise<number> {
  let applied = 0;
  for (let drained = 0; drained < maximumCommands; drained += 1) {
    const result = await mailbox.claim();
    if (result.status !== 'claimed') break;
    const { claim } = result;
    const command = readInlinePayload(claim.payload);
    if (command !== undefined) {
      // Apply BEFORE acknowledging, per command. `apply` is the caller's
      // replay into the in-memory gate, and acknowledging is what durably
      // forgets the command — so acknowledging first would open a window
      // where a crash loses it from both sides at once: already forgotten
      // durably, never applied in memory.
      //
      // An earlier version of this function collected the whole batch,
      // acknowledging as it went, and let the caller admit afterwards.
      // That contradicted this function's own crash-safety claim, and the
      // window was up to `maximumCommands` wide.
      //
      // `apply` is synchronous by contract for the same reason: an async
      // replay would reintroduce an await between the gate write and the
      // acknowledgement.
      apply(command);
      applied += 1;
      await mailbox.acknowledge({
        commandId: claim.receipt.commandId,
        attemptToken: claim.attemptToken,
      });
    } else {
      // A malformed or reference-form payload is rejected outright rather
      // than replayed: a partial record must never become a steering
      // decision, and leaving it claimed would have it reappear on every
      // subsequent boot forever.
      await mailbox.reject({
        commandId: claim.receipt.commandId,
        attemptToken: claim.attemptToken,
        failure: { reason: 'application', message: 'unreadable steering payload' },
        retry: false,
      });
    }
  }
  return applied;
}

function readInlinePayload(payload: {
  readonly form: string;
  readonly value?: unknown;
}): PersistedSteeringCommand | undefined {
  if (payload.form !== 'inline') return undefined;
  const value = payload.value;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<PersistedSteeringCommand>;
  // Fail closed on a malformed record rather than replaying a partial
  // command into desired state: a hostile or truncated payload must not
  // become a steering decision.
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.principal !== 'string' ||
    typeof candidate.requestedAt !== 'string' ||
    typeof candidate.requestedValue !== 'object' ||
    candidate.requestedValue === null
  ) {
    return undefined;
  }
  return candidate as PersistedSteeringCommand;
}
