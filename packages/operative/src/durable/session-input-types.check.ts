/**
 * Compile-only fixture for AB-42's session-input admission types (AB-193;
 * AB-202 amendments).
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

// AB-202 — `SessionInputRecord`/`SessionInputAdmissionRequest` are now bounded
// generics (`TPayload extends SessionInputPayload`); a type argument that is
// not assignable to `SessionInputPayload` must fail to compile.
// @ts-expect-error — `Date` does not extend `SessionInputPayload`.
export type InvalidSessionInputRecord = SessionInputRecord<Date>;

// AB-202 — `SessionInputPayload` excludes provider-generated block kinds. A
// payload array containing a `thinking` block must fail to compile.
const providerGeneratedPayload: ReadonlyArray<{
  type: 'thinking';
  thinking: string;
  signature: string;
}> = [{ type: 'thinking', thinking: 'internal reasoning', signature: 'sig' }];
// @ts-expect-error — a `thinking` block is provider-generated, not user-admissible.
const rejectedPayload: SessionInputPayload = providerGeneratedPayload;

// AB-202 — every non-excluded `MultiModalContent` kind (including
// `container_upload`, deliberately left admissible: it references a
// user-initiated container file upload, not a provider-generated block) must
// still be assignable to `SessionInputPayload`, so the `Exclude<>` above
// didn't over-exclude down to `never`.
const admissiblePayload: SessionInputPayload = [
  { type: 'text', text: 'Summarize this.' },
  { type: 'image', url: 'https://example.invalid/chart.png' },
  {
    type: 'document',
    name: 'q3.pdf',
    mimeType: 'application/pdf',
    source: { kind: 'reference', uri: 'file:///q3.pdf' },
  },
  { type: 'container_upload', file_id: 'file-1' },
];

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
  providerGeneratedPayload,
  rejectedPayload,
  admissiblePayload,
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
