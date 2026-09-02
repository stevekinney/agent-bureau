/**
 * Compile-only fixture for AB-42's session-input admission types (AB-193).
 *
 * This file is included in `check-types` (it lives under `src/`, which
 * `tsconfig.json` includes) and excluded from the test runner (it does not
 * match `*.test.ts`/`*.spec.ts`, and `tsconfig.test.json` only includes those
 * patterns). It constructs one value of each type AB-193 exports so an
 * accidental field rename or shape drift fails `check-types` immediately.
 * There is no runtime behavior to assert here — the compiler is the test.
 */
import type {
  SessionInputAdmissionOutcome,
  SessionInputAdmissionRequest,
  SessionInputConflict,
  SessionInputDeliveryMode,
  SessionInputFailure,
  SessionInputPayload,
  SessionInputPromotion,
  SessionInputReceipt,
  SessionInputRecord,
  SessionInputState,
} from './types';

const deliveryMode: SessionInputDeliveryMode = 'steer';
const otherDeliveryMode: SessionInputDeliveryMode = 'queue';

const payload: SessionInputPayload = 'Summarize the Q3 report.';

const record: SessionInputRecord = {
  id: 'input-1',
  idOrigin: 'caller',
  sessionId: 'session-1',
  principal: 'user-1',
  deliveryMode,
  payload,
  payloadDigest: 'sha256:deadbeef',
  admittedAt: '2026-09-02T00:00:00.000Z',
  expiresAt: '2026-09-02T01:00:00.000Z',
  supersedes: 'input-0',
};

const request: SessionInputAdmissionRequest = {
  id: 'input-1',
  principal: 'user-1',
  deliveryMode: otherDeliveryMode,
  payload,
  expiresAt: '2026-09-02T01:00:00.000Z',
  supersedes: 'input-0',
};

const receipt: SessionInputReceipt = {
  id: record.id,
  sessionId: record.sessionId,
  deliveryMode: record.deliveryMode,
  admissionSequence: 1,
  revision: 1,
  state: 'accepted',
  admittedAt: record.admittedAt,
};

const conflict: SessionInputConflict = {
  id: record.id,
  reason: 'payload-mismatch',
  originalReceipt: receipt,
};

const admittedOutcome: SessionInputAdmissionOutcome = { outcome: 'admitted', receipt };
const replayedOutcome: SessionInputAdmissionOutcome = { outcome: 'replayed', receipt };
const conflictOutcome: SessionInputAdmissionOutcome = { outcome: 'conflict', conflict };
const notFoundOutcome: SessionInputAdmissionOutcome = { outcome: 'not-found' };
const sessionTerminalOutcome: SessionInputAdmissionOutcome = {
  outcome: 'session-terminal',
  sessionId: record.sessionId,
};
const unsupportedCapabilityOutcome: SessionInputAdmissionOutcome = {
  outcome: 'unsupported-capability',
  reason: 'durable-mailbox-unavailable',
};
const backlogExhaustedOutcome: SessionInputAdmissionOutcome = {
  outcome: 'backlog-exhausted',
  scope: 'session',
  limit: 10,
};

const states: readonly SessionInputState[] = [
  'accepted',
  'queued',
  'promoted',
  'rejected',
  'expired',
  'superseded',
  'canceled',
  'failed',
];

const promotion: SessionInputPromotion = {
  promotedAt: '2026-09-02T00:00:01.000Z',
  conversationMessageId: 'message-1',
  providerTurn: 3,
};

const failure: SessionInputFailure = {
  failedAt: '2026-09-02T00:00:02.000Z',
  reason: 'deadline-passed',
};

// Referenced so `noUnusedLocals` cannot flag the fixture values above; there is
// no runtime assertion here, only the compiler checking every shape compiles.
export const sessionInputTypeFixture = {
  record,
  request,
  receipt,
  conflict,
  admittedOutcome,
  replayedOutcome,
  conflictOutcome,
  notFoundOutcome,
  sessionTerminalOutcome,
  unsupportedCapabilityOutcome,
  backlogExhaustedOutcome,
  states,
  promotion,
  failure,
};
