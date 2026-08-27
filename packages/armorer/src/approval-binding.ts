import { stableStringifyJson } from './core/serialization/json';
import type { ToolRequestContext } from './execution-context';

export const APPROVAL_BINDING_VERSION = 1 as const;

export type ApprovalBindingPayload = {
  version: typeof APPROVAL_BINDING_VERSION;
  principalId: string;
  tenantId: string;
  ownerId: string;
  authorizationRevision: string;
  capabilitiesRevision: string;
  audience: NonNullable<ToolRequestContext['audience']>;
  agentId: string;
  runId: string;
  toolboxRevision: string;
  toolDefinitionRevision: string;
  policyRevision: string;
  approvalRevision: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  replayScope: string;
};

export type ApprovalBindingContext = Pick<
  ApprovalBindingPayload,
  | 'principalId'
  | 'tenantId'
  | 'ownerId'
  | 'authorizationRevision'
  | 'capabilitiesRevision'
  | 'audience'
  | 'agentId'
  | 'runId'
  | 'toolboxRevision'
  | 'toolDefinitionRevision'
  | 'policyRevision'
  | 'approvalRevision'
>;

export type ApprovalState = 'issued' | 'consumed' | 'revoked';

export class ApprovalBindingError extends Error {
  constructor(
    message: string,
    readonly code:
      'invalid-binding' | 'expired' | 'revoked' | 'already-consumed' | 'not-found' | 'mismatch',
  ) {
    super(message);
    this.name = 'ApprovalBindingError';
  }
}

function assertFiniteTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApprovalBindingError(
      `Approval binding ${label} must be a finite number.`,
      'invalid-binding',
    );
  }
}

function validateApprovalClock(now: number): number {
  assertFiniteTimestamp(now, 'validation time');
  return now;
}

export interface ApprovalStateStore {
  issue(binding: ApprovalBindingPayload): Promise<void>;
  consume(
    binding: ApprovalBindingPayload,
    context?: Partial<ApprovalBindingContext>,
    now?: number,
  ): Promise<void>;
  revoke(binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>): Promise<void>;
  state(
    binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>,
  ): Promise<ApprovalState | undefined>;
}

export function validateApprovalBinding(
  binding: ApprovalBindingPayload,
  context?: Partial<ApprovalBindingContext>,
  now = Date.now(),
): void {
  if (
    binding.version !== APPROVAL_BINDING_VERSION ||
    !Object.values(binding).every((value) => typeof value === 'number' || typeof value === 'string')
  ) {
    throw new ApprovalBindingError('Invalid approval binding payload.', 'invalid-binding');
  }
  assertFiniteTimestamp(binding.issuedAt, 'issuedAt');
  assertFiniteTimestamp(binding.expiresAt, 'expiresAt');
  const validationTime = validateApprovalClock(now);
  if (binding.issuedAt >= binding.expiresAt) {
    throw new ApprovalBindingError('Invalid approval binding payload.', 'invalid-binding');
  }
  if (validationTime >= binding.expiresAt) {
    throw new ApprovalBindingError('Approval binding has expired.', 'expired');
  }
  for (const key of Object.keys(context ?? {}) as Array<keyof ApprovalBindingContext>) {
    if (context?.[key] !== undefined && context[key] !== binding[key]) {
      throw new ApprovalBindingError(`Approval binding ${key} does not match.`, 'mismatch');
    }
  }
}

/** Process-local, atomic single-use approval state. */
export function createProcessLocalApprovalStateStore(nowFunction = Date.now): ApprovalStateStore {
  const issued = new Map<string, ApprovalBindingPayload>();
  const terminal = new Map<
    string,
    { state: Exclude<ApprovalState, 'issued'>; expiresAt: number }
  >();
  const keyOf = (binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>) =>
    `${binding.replayScope}\u0000${binding.nonce}`;
  const purgeExpired = (now: number) => {
    for (const [key, binding] of issued) {
      if (now >= binding.expiresAt) issued.delete(key);
    }
    for (const [key, entry] of terminal) {
      if (now >= entry.expiresAt) terminal.delete(key);
    }
  };

  return {
    issue(binding) {
      return Promise.resolve().then(() => {
        const now = validateApprovalClock(nowFunction());
        purgeExpired(now);
        validateApprovalBinding(binding, undefined, now);
        const key = keyOf(binding);
        if (issued.has(key) || terminal.has(key)) {
          throw new ApprovalBindingError(
            'Approval binding nonce has already been issued.',
            'already-consumed',
          );
        }
        issued.set(key, binding);
      });
    },
    consume(binding, context, now = nowFunction()) {
      return Promise.resolve().then(() => {
        const validationTime = validateApprovalClock(now);
        validateApprovalBinding(binding, context, validationTime);
        purgeExpired(validationTime);
        const key = keyOf(binding);
        const terminalEntry = terminal.get(key);
        if (terminalEntry?.state === 'revoked')
          throw new ApprovalBindingError('Approval binding was revoked.', 'revoked');
        if (terminalEntry?.state === 'consumed') {
          throw new ApprovalBindingError(
            'Approval binding has already been consumed.',
            'already-consumed',
          );
        }
        const issuedBinding = issued.get(key);
        if (!issuedBinding)
          throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
        if (stableStringifyJson(issuedBinding) !== stableStringifyJson(binding)) {
          throw new ApprovalBindingError(
            'Approval binding does not match the issued payload.',
            'mismatch',
          );
        }
        issued.delete(key);
        terminal.set(key, { state: 'consumed', expiresAt: binding.expiresAt });
      });
    },
    revoke(binding) {
      return Promise.resolve().then(() => {
        const now = validateApprovalClock(nowFunction());
        purgeExpired(now);
        const key = keyOf(binding);
        const terminalEntry = terminal.get(key);
        if (terminalEntry?.state === 'consumed') {
          throw new ApprovalBindingError(
            'Approval binding has already been consumed.',
            'already-consumed',
          );
        }
        const issuedBinding = issued.get(key);
        if (!issuedBinding) {
          if (terminalEntry?.state === 'revoked') return;
          throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
        }
        issued.delete(key);
        terminal.set(key, { state: 'revoked', expiresAt: issuedBinding.expiresAt });
      });
    },
    state(binding) {
      return Promise.resolve().then(() => {
        const now = validateApprovalClock(nowFunction());
        purgeExpired(now);
        const key = keyOf(binding);
        return issued.has(key) ? 'issued' : terminal.get(key)?.state;
      });
    },
  };
}
