import type { ToolRequestContext } from './execution-context';

export const APPROVAL_BINDING_VERSION = 1 as const;

export type ApprovalBindingPayload = {
  version: typeof APPROVAL_BINDING_VERSION;
  principalId: string;
  tenantId: string;
  audience: NonNullable<ToolRequestContext['audience']>;
  agentId: string;
  runId: string;
  toolboxRevision: string;
  toolDefinitionRevision: string;
  policyRevision: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  replayScope: string;
};

export type ApprovalBindingContext = Pick<
  ApprovalBindingPayload,
  | 'principalId'
  | 'tenantId'
  | 'audience'
  | 'agentId'
  | 'runId'
  | 'toolboxRevision'
  | 'toolDefinitionRevision'
  | 'policyRevision'
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
    !Object.values(binding).every(
      (value) => typeof value === 'number' || typeof value === 'string',
    ) ||
    binding.issuedAt >= binding.expiresAt
  ) {
    throw new ApprovalBindingError('Invalid approval binding payload.', 'invalid-binding');
  }
  if (now >= binding.expiresAt) {
    throw new ApprovalBindingError('Approval binding has expired.', 'expired');
  }
  for (const key of Object.keys(context ?? {}) as Array<keyof ApprovalBindingContext>) {
    if (context?.[key] !== undefined && context[key] !== binding[key]) {
      throw new ApprovalBindingError(`Approval binding ${key} does not match.`, 'mismatch');
    }
  }
}

/** Process-local, atomic single-use approval state. */
export function createProcessLocalApprovalStateStore(): ApprovalStateStore {
  const states = new Map<string, { binding: ApprovalBindingPayload; state: ApprovalState }>();
  const keyOf = (binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>) =>
    `${binding.replayScope}\u0000${binding.nonce}`;

  return {
    issue(binding) {
      return Promise.resolve().then(() => {
        validateApprovalBinding(binding);
        const key = keyOf(binding);
        if (states.has(key)) {
          throw new ApprovalBindingError(
            'Approval binding nonce has already been issued.',
            'already-consumed',
          );
        }
        states.set(key, { binding, state: 'issued' });
      });
    },
    consume(binding, context, now = Date.now()) {
      return Promise.resolve().then(() => {
        validateApprovalBinding(binding, context, now);
        const entry = states.get(keyOf(binding));
        if (!entry) throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
        if (entry.state === 'revoked')
          throw new ApprovalBindingError('Approval binding was revoked.', 'revoked');
        if (entry.state === 'consumed') {
          throw new ApprovalBindingError(
            'Approval binding has already been consumed.',
            'already-consumed',
          );
        }
        if (JSON.stringify(entry.binding) !== JSON.stringify(binding)) {
          throw new ApprovalBindingError(
            'Approval binding does not match the issued payload.',
            'mismatch',
          );
        }
        entry.state = 'consumed';
      });
    },
    revoke(binding) {
      return Promise.resolve().then(() => {
        const entry = states.get(keyOf(binding));
        if (!entry) throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
        if (entry.state === 'consumed') {
          throw new ApprovalBindingError(
            'Approval binding has already been consumed.',
            'already-consumed',
          );
        }
        entry.state = 'revoked';
      });
    },
    state(binding) {
      return Promise.resolve(states.get(keyOf(binding))?.state);
    },
  };
}
